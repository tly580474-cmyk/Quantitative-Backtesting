import importlib.util
import http.client
import secrets
import shutil
import subprocess
import threading
from urllib.parse import urlencode
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('gateway-session.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.credentials = Path(self.temp.name) / 'htpasswd'
        self.credentials.write_text('test:hash')
        self.database = str(Path(self.temp.name) / 'sessions.sqlite')
        self.sessions = gateway.Sessions(self.database, self.credentials)

    def test_sliding_expiry_and_restart(self):
        token = self.sessions.create('test', now=0)
        self.assertTrue(self.sessions.touch(token, now=gateway.TTL - 1))
        restarted = gateway.Sessions(self.database, self.credentials)
        self.assertTrue(restarted.touch(token, now=2 * gateway.TTL - 2))
        self.assertFalse(restarted.touch(token, now=3 * gateway.TTL - 2))
        self.assertFalse(restarted.touch(token, now=3 * gateway.TTL))

    def test_independent_devices_tampering_and_logout(self):
        first, second = self.sessions.create('test', now=0), self.sessions.create('test', now=0)
        self.sessions.revoke(first)
        self.assertFalse(self.sessions.touch(first, now=1))
        self.assertTrue(self.sessions.touch(second, now=1))
        self.assertFalse(self.sessions.touch(second + 'x', now=1))

    def test_password_change_revokes_sessions(self):
        token = self.sessions.create('test', now=0)
        self.credentials.write_text('test:new-hash')
        self.assertFalse(self.sessions.touch(token, now=1))

    def test_rate_limit_and_redirect_validation(self):
        for _ in range(10):
            self.assertTrue(self.sessions.allow_attempt('127.0.0.1'))
        self.assertFalse(self.sessions.allow_attempt('127.0.0.1'))
        self.assertTrue(self.sessions.allow_attempt('127.0.0.2'))
        for target in ['https://evil.test', '//evil.test', '/\\evil.test', '/\r\nX: bad']:
            self.assertEqual(gateway.safe_return(target), '/')
        self.assertEqual(gateway.safe_return('/stocks?x=1'), '/stocks?x=1')

    @unittest.skipUnless(shutil.which('htpasswd'), 'requires Linux htpasswd')
    def test_http_login_with_isolated_credentials(self):
        password = secrets.token_urlsafe(24)
        subprocess.run(['htpasswd', '-ci', str(self.credentials), 'fixture'],
                       input=password + '\n', text=True, capture_output=True, check=True)
        previous = gateway.PASSWORD_FILE
        gateway.PASSWORD_FILE = str(self.credentials)
        self.addCleanup(setattr, gateway, 'PASSWORD_FILE', previous)
        server = gateway.ThreadingHTTPServer(('127.0.0.1', 0), gateway.Handler)
        server.sessions = self.sessions
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(path, method='GET', body=None, cookie=None, origin='https://fixture.local'):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            headers = {'Host': 'fixture.local', 'X-Forwarded-Proto': 'https'}
            if body is not None: headers['Content-Type'] = 'application/x-www-form-urlencoded'
            if cookie: headers['Cookie'] = cookie
            if origin: headers['Origin'] = origin
            conn.request(method, path, body, headers)
            response = conn.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            conn.close()
            return result

        self.assertEqual(request('/check')[0], 401)
        self.assertEqual(request('/auth/login', 'POST', 'username=fixture&password=wrong')[0], 401)
        form = urlencode({'username': 'fixture', 'password': password, 'next': '/stocks'})
        self.assertEqual(request('/auth/login', 'POST', form, origin='https://evil.test')[0], 403)
        status, headers, _ = request('/auth/login', 'POST', form, origin='https://fixture.local')
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/stocks')
        for flag in ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=259200']:
            self.assertIn(flag, headers['Set-Cookie'])
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertEqual(request('/check', cookie=cookie)[0], 204)
        self.assertIn('Set-Cookie', request('/check', cookie=cookie)[1])
        self.assertEqual(request('/auth/logout', 'POST', cookie=cookie)[0], 303)
        self.assertEqual(request('/check', cookie=cookie)[0], 401)


if __name__ == '__main__':
    unittest.main()
