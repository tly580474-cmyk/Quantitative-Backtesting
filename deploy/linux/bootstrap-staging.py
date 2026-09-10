"""First-install bootstrap for full-data acceptance; never enables source collectors."""
from pathlib import Path
import secrets
import subprocess

root = Path('/opt/quant-backtest')
p = root / 'server/.env'
if p.exists(): raise SystemExit('Existing config preserved')
subprocess.run(['mysql', '-e', 'CREATE DATABASE quant_backtest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'], check=True)
password, token, web = secrets.token_hex(24), secrets.token_hex(24), secrets.token_hex(12)
subprocess.run(['mysql'], input=f"CREATE USER 'quant_app'@'127.0.0.1' IDENTIFIED BY '{password}'; GRANT ALL ON quant_backtest.* TO 'quant_app'@'127.0.0.1';", text=True, check=True)
template = (root / 'deploy/linux/.env.test.example').read_text()
template = template.replace('DB_USER=quant_test', 'DB_USER=quant_app').replace('DB_NAME=quant_backtest_linux_test', 'DB_NAME=quant_backtest')
template = template.replace('REPLACE_WITH_GENERATED_PASSWORD', password).replace('REPLACE_WITH_GENERATED_TOKEN', token)
template = template.replace('192.168.171.140', '192.168.2.218').replace('QUANT_TEST_MODE=true', 'QUANT_TEST_MODE=false\nBACKGROUND_JOBS_ENABLED=false')
template += '\nDUCKDB_MAX_CONCURRENT=1\nDUCKDB_MAX_TEMP_SIZE=8GB\nAGENT_MAX_CONCURRENT=1\n'
p.write_text(template); p.chmod(0o600)
with open('/etc/nginx/quant.htpasswd', 'w') as output:
    subprocess.run(['htpasswd', '-niB', 'quant'], input=web+'\n', text=True, stdout=output, check=True)
Path('/etc/nginx/quant.htpasswd').chmod(0o640)
subprocess.run(['chown', 'root:www-data', '/etc/nginx/quant.htpasswd'], check=True)
access = Path('/root/quant-staging-access.txt')
access.write_text(f'UI: http://192.168.2.218:8080\nAdmin: http://192.168.2.218:8081\nGateway user: quant\nGateway password: {web}\nAdmin API token: {token}\n')
access.chmod(0o600)
print('Full-data staging config created; all background jobs disabled.')
