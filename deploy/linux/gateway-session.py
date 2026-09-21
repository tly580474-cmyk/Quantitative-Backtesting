#!/usr/bin/env python3
"""Loopback nginx auth_request service; durable, sliding 72-hour device sessions."""
import hashlib
import html
import os
import re
from pathlib import Path
import secrets
import sqlite3
import subprocess
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

TTL = 3 * 24 * 60 * 60
COOKIE = 'quant_device_session'
DATABASE = os.environ.get('QUANT_SESSION_DB', '/var/lib/quant-gateway/sessions.sqlite')
PASSWORD_FILE = os.environ.get('QUANT_PASSWORD_FILE', '/etc/nginx/quant.htpasswd')


class Sessions:
    def __init__(self, path, credential_file):
        self.path, self.credential_file = path, credential_file
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, touched REAL, credentials TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER, started REAL)')

    def fingerprint(self):
        return hashlib.sha256(Path(self.credential_file).read_bytes()).hexdigest()

    def create(self, username, now=None):
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        with sqlite3.connect(self.path) as db:
            db.execute('DELETE FROM sessions WHERE touched <= ?', (now - TTL,))
            db.execute('INSERT INTO sessions VALUES (?, ?, ?, ?)',
                       (self.digest(token), username, now, self.fingerprint()))
        return token

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def touch(self, token, now=None):
        now = time.time() if now is None else now
        with sqlite3.connect(self.path) as db:
            return db.execute('UPDATE sessions SET touched = ? WHERE token = ? AND touched > ? AND credentials = ?',
                              (now, self.digest(token), now - TTL, self.fingerprint())).rowcount == 1

    def revoke(self, token):
        with sqlite3.connect(self.path) as db:
            db.execute('DELETE FROM sessions WHERE token = ?', (self.digest(token),))

    def allow_attempt(self, ip):
        now = time.time()
        with sqlite3.connect(self.path) as db:
            db.execute('DELETE FROM attempts WHERE started < ?', (now - 300,))
            db.execute('INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = count + 1', (ip, now))
            return db.execute('SELECT count FROM attempts WHERE ip = ?', (ip,)).fetchone()[0] <= 10


def verify_password(username, password):
    if not 0 < len(username) <= 128 or len(password) > 1024 or username.startswith('-') or ':' in username or any(c in username + password for c in '\r\n\x00'):
        return False
    try:
        result = subprocess.run(['/usr/bin/htpasswd', '-vi', PASSWORD_FILE, username],
                                input=password + '\n', text=True, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=5)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def safe_return(value):
    return value if (value.startswith('/') and not value.startswith('//')
                     and '\\' not in value and not any(ord(c) < 32 for c in value)
                     and not value.startswith('/auth/')) else '/'


def login_page(return_to, error=''):
    return f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录量化工作台</title>
<style>body{{margin:0;background:#f3f6fb;color:#16243a;font:16px system-ui;display:grid;place-items:center;min-height:100vh}}
main{{background:white;padding:36px;border-radius:16px;box-shadow:0 8px 40px #17243a15;width:min(360px,80vw)}}
h1{{font-size:24px}}p{{color:#627089;line-height:1.6}}label{{display:block;margin-top:18px}}input{{box-sizing:border-box;width:100%;padding:12px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}}
button{{margin-top:24px;width:100%;padding:12px;background:#2563eb;color:white;border:0;border-radius:8px;font:inherit;cursor:pointer}}.error{{color:#b42318}}</style>
<main><h1>登录量化工作台</h1><p>此浏览器登录后自动记住。连续三天未访问时，需要重新登录。</p>
<p class="error" role="alert">{html.escape(error)}</p><form method="post" action="/auth/login">
<input type="hidden" name="next" value="{html.escape(return_to, quote=True)}">
<label>用户名<input name="username" autocomplete="username" required maxlength="128" autofocus></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
<button type="submit">登录</button></form></main></html>'''.encode()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass  # Never log credentials, cookies or login request bodies.

    def token(self):
        try:
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
            token = cookies[COOKIE].value if COOKIE in cookies else ''
            return token if re.fullmatch(r'[A-Za-z0-9_-]{43}', token) else ''
        except Exception:
            return ''

    def cookie(self, token, age=TTL):
        secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
        return f'{COOKIE}={token}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}'

    def respond(self, status, body=b'', cookie=None, location=None):
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        # Native form POSTs under no-referrer send Origin: null, which our
        # source check must reject. Preserve Origin on same-origin navigation.
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if location:
            self.send_header('Location', location)
        self.end_headers()
        self.wfile.write(body)

    def same_origin(self, origin, fetch_site):
        expected = self.headers.get('X-Forwarded-Proto', 'http') + '://' + self.headers.get('Host', '')
        # A cookie is not proof of intent: require the browser's full origin,
        # including port. SameSite alone also trusts other apps on this host.
        return origin == expected and fetch_site not in ('cross-site', 'same-site')

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == '/check':
            token = self.token()
            if self.headers.get('X-Original-Method', 'GET') not in ('GET', 'HEAD', 'OPTIONS'):
                if not self.same_origin(self.headers.get('X-Original-Origin'), self.headers.get('X-Original-Fetch-Site')):
                    return self.respond(403)
            if token and self.server.sessions.touch(token):
                return self.respond(204, cookie=self.cookie(token))
            return self.respond(401)
        if path.path == '/auth/login':
            target = safe_return(parse_qs(path.query).get('next', ['/'])[0])
            return self.respond(200, login_page(target))
        self.respond(404)

    def do_POST(self):
        # Nginx overwrites Host/forwarded headers; refuse cross-origin login/logout.
        if not self.same_origin(self.headers.get('Origin'), self.headers.get('Sec-Fetch-Site')):
            return self.respond(403)
        path = urlsplit(self.path).path
        if path == '/auth/logout':
            self.server.sessions.revoke(self.token())
            return self.respond(303, cookie=self.cookie('', 0), location='/auth/login')
        if path != '/auth/login':
            return self.respond(404)
        if self.headers.get_content_type() != 'application/x-www-form-urlencoded':
            return self.respond(415)
        if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
            return self.respond(400)
        if not self.server.sessions.allow_attempt(self.headers.get('X-Real-IP', 'unknown')):
            return self.respond(429, login_page('/', '尝试次数过多，请五分钟后重试。'))
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                return self.respond(400)
            fields = parse_qs(self.rfile.read(length).decode('utf-8'), max_num_fields=3, keep_blank_values=True)
            if any(len(values) != 1 for values in fields.values()):
                return self.respond(400)
        except (ValueError, UnicodeError):
            return self.respond(400)
        username, password = fields.get('username', [''])[0], fields.get('password', [''])[0]
        target = safe_return(fields.get('next', ['/'])[0])
        if not verify_password(username, password):
            return self.respond(401, login_page(target, '用户名或密码不正确。'))
        self.server.sessions.revoke(self.token())
        token = self.server.sessions.create(username)
        self.respond(303, cookie=self.cookie(token), location=target)


if __name__ == '__main__':
    Path(DATABASE).parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 3002), Handler)
    server.sessions = Sessions(DATABASE, PASSWORD_FILE)
    server.serve_forever()
