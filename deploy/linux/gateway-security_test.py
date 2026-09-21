"""Security regression tests against an isolated nginx + gateway + dummy API.

Uses freshly generated credentials and temporary state only. Never reads the
deployed password file or existing device sessions, and never writes real APIs.
"""
import hashlib
import http.client
import importlib.util
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('gateway', ROOT / 'gateway-session.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class DummyApi(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.writes += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'fixture API')

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'fixture API')

    def log_message(self, *_args):
        pass


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which('nginx') and shutil.which('htpasswd'), 'requires Linux nginx and htpasswd')
class GatewaySecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='quant-gateway-security-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.password = secrets.token_urlsafe(24)
        cls.credentials = cls.root / 'accounts'
        subprocess.run(['htpasswd', '-ci', str(cls.credentials), 'fixture'], input=cls.password + '\n',
                       text=True, capture_output=True, check=True)
        gateway.PASSWORD_FILE = str(cls.credentials)
        cls.auth = gateway.ThreadingHTTPServer(('127.0.0.1', 0), gateway.Handler)
        cls.auth.sessions = gateway.Sessions(str(cls.root / 'sessions.sqlite'), cls.credentials)
        cls.api = ThreadingHTTPServer(('127.0.0.1', 0), DummyApi)
        cls.api.writes = 0
        for server in [cls.auth, cls.api]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            cls.addClassCleanup(server.server_close)
            cls.addClassCleanup(server.shutdown)
        cls.port = unused_port()
        cls.origin = f'http://127.0.0.1:{cls.port}'
        (cls.root / 'index.html').write_text('fixture protected page')
        session_conf = (ROOT / 'nginx-session.conf').read_text().replace('127.0.0.1:3002', f'127.0.0.1:{cls.auth.server_port}')
        config = f'''pid {cls.root}/nginx.pid;
error_log {cls.root}/error.log;
events {{ worker_connections 64; }}
http {{
  access_log off;
  client_body_temp_path {cls.root}/body;
  proxy_temp_path {cls.root}/proxy;
  server {{
    listen 127.0.0.1:{cls.port};
    root {cls.root};
    {session_conf}
    location / {{ try_files $uri /index.html; }}
    location /api/ {{ proxy_pass http://127.0.0.1:{cls.api.server_port}; }}
  }}
}}'''
        path = cls.root / 'nginx.conf'
        path.write_text(config)
        cls.nginx = subprocess.Popen(['nginx', '-p', str(cls.root), '-c', str(path), '-g', 'daemon off;'],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        def stop_nginx():
            cls.nginx.terminate()
            cls.nginx.communicate(timeout=5)
        cls.addClassCleanup(stop_nginx)
        for _ in range(50):
            if cls.nginx.poll() is not None:
                raise RuntimeError(cls.nginx.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('isolated nginx did not start')

    def setUp(self):
        with sqlite3.connect(self.root / 'sessions.sqlite') as db:
            db.execute('DELETE FROM attempts')
            db.execute('DELETE FROM sessions')

    def request(self, path, method='GET', body=None, cookie=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        request_headers = {'Origin': self.origin, 'Content-Type': 'application/x-www-form-urlencoded'}
        request_headers.update(headers or {})
        request_headers = {key: value for key, value in request_headers.items() if value is not None}
        if cookie: request_headers['Cookie'] = cookie
        conn.request(method, path, body, request_headers)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def login(self, cookie=None, next_path='/'):
        status, headers, _ = self.request('/auth/login', 'POST',
                                         urlencode({'username': 'fixture', 'password': self.password, 'next': next_path}), cookie)
        self.assertEqual(status, 303)
        self.assertIn('Max-Age=259200', headers['Set-Cookie'])
        return headers['Set-Cookie'].split(';')[0], headers

    def test_unauthenticated_requests_cannot_bypass_gateway(self):
        for path in ['/api/private', '/api//private', '/api/%70rivate']:
            self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.request('/_quant_session')[0], 404)
        self.assertEqual(self.request('/auth/../api/private')[0], 401)
        self.assertEqual(self.request('/api/private', headers={'X-Original-Method': 'GET', 'X-Original-Origin': self.origin,
                                                            'X-Real-IP': '127.0.0.1'})[0], 401)

    def test_real_login_rotation_logout_and_cookie_flags(self):
        first, headers = self.login()
        for flag in ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=259200']:
            self.assertIn(flag, headers['Set-Cookie'])
        self.assertNotIn('Secure', headers['Set-Cookie'])  # This fixture really is HTTP.
        self.assertEqual(self.request('/api/private', cookie=first)[0], 200)
        self.assertIn('Set-Cookie', self.request('/', cookie=first)[1])
        second, _ = self.login(first)
        self.assertNotEqual(first, second)
        self.assertEqual(self.request('/api/private', cookie=first)[0], 401)
        self.assertEqual(self.request('/auth/logout', 'POST', cookie=second)[0], 303)
        self.assertEqual(self.request('/api/private', cookie=second)[0], 401)

    def test_idle_expiry_and_tampering_fail_closed(self):
        cookie, _ = self.login()
        self.assertEqual(self.request('/api/private', cookie=cookie + 'x')[0], 401)
        token = cookie.split('=', 1)[1]
        with sqlite3.connect(self.root / 'sessions.sqlite') as db:
            stored = db.execute('SELECT token FROM sessions').fetchone()[0]
            self.assertEqual(stored, hashlib.sha256(token.encode()).hexdigest())
            self.assertNotEqual(stored, token)
            db.execute('UPDATE sessions SET touched = ?', (time.time() - gateway.TTL - 1,))
        self.assertEqual(self.request('/api/private', cookie=cookie)[0], 401)

    def test_login_and_logout_require_same_origin(self):
        cookie, _ = self.login()
        for origin in [None, 'null', 'http://evil.invalid', self.origin + '.evil', 'http://127.0.0.1:1']:
            self.assertEqual(self.request('/auth/logout', 'POST', cookie=cookie, headers={'Origin': origin})[0], 403)
            self.assertEqual(self.request('/auth/login', 'POST', 'username=fixture&password=x', headers={'Origin': origin})[0], 403)
        self.assertEqual(self.request('/api/private', cookie=cookie)[0], 200)

    def test_cookie_authenticated_writes_require_same_origin_and_ignore_spoofed_headers(self):
        cookie, _ = self.login()
        before = self.api.writes
        for origin in [None, 'null', 'http://evil.invalid', 'http://127.0.0.1:1']:
            status = self.request('/api/private', 'POST', 'fixture=1', cookie, {
                'Origin': origin, 'X-Original-Method': 'GET', 'X-Original-Origin': self.origin,
                'X-Original-Fetch-Site': 'same-origin', 'X-Forwarded-Proto': 'https',
            })[0]
            self.assertEqual(status, 403, origin)
        self.assertEqual(self.api.writes, before)
        self.assertEqual(self.request('/api/private', 'POST', 'fixture=1', cookie)[0], 200)
        self.assertEqual(self.api.writes, before + 1)

    def test_rate_limit_cannot_be_bypassed_with_forwarded_ip(self):
        for number in range(10):
            self.assertEqual(self.request('/auth/login', 'POST', 'username=fixture&password=wrong',
                                          headers={'X-Real-IP': f'192.0.2.{number}', 'X-Forwarded-For': f'192.0.2.{number}'})[0], 401)
        self.assertEqual(self.request('/auth/login', 'POST', 'username=fixture&password=wrong',
                                      headers={'X-Real-IP': '192.0.2.200'})[0], 429)

    def test_oversized_duplicate_and_wrong_type_payloads_are_rejected(self):
        self.assertEqual(self.request('/auth/login', 'POST', 'x' * 9000)[0], 413)
        self.assertEqual(self.request('/auth/login', 'POST', '{}', headers={'Content-Type': 'application/json'})[0], 415)
        self.assertEqual(self.request('/auth/login', 'POST', 'username=a&username=b&password=c')[0], 400)
        self.assertEqual(self.request('/auth/login', 'POST', 'a=1&b=2&c=3&d=4')[0], 400)

    def test_redirect_html_injection_and_framing_protection(self):
        for target in ['//evil.invalid', 'https://evil.invalid', '/\\evil.invalid', '/\r\nX-Injected: yes']:
            _, headers = self.login(next_path=target)
            self.assertEqual(headers['Location'], '/')
        payload = '/"><script>alert(1)</script>'
        status, headers, body = self.request('/auth/login?' + urlencode({'next': payload}))
        self.assertEqual(status, 200)
        self.assertNotIn(b'<script>', body)
        self.assertIn(b'&lt;script&gt;', body)
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        # Unlike no-referrer, this permits a native same-origin form POST to
        # carry its real Origin. Null/missing origins remain forbidden above.
        self.assertEqual(headers['Referrer-Policy'], 'same-origin')


if __name__ == '__main__':
    unittest.main(verbosity=2)
