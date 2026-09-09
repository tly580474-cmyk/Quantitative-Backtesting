"""Create ONLY the isolated, bounded test database; generate credentials on the VM."""
from pathlib import Path
import secrets
import subprocess

root = Path('/opt/quant-backtest')
env_path = root / 'server/.env'
if env_path.exists():
    raise SystemExit('Existing server/.env preserved; bootstrap is first-install only')
password = secrets.token_hex(24)
admin = secrets.token_hex(24)
web = secrets.token_hex(12)
subprocess.run(['mysql'], input=f"CREATE DATABASE IF NOT EXISTS quant_backtest_linux_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER IF NOT EXISTS 'quant_test'@'127.0.0.1' IDENTIFIED BY '{password}';\nALTER USER 'quant_test'@'127.0.0.1' IDENTIFIED BY '{password}';\nGRANT ALL ON quant_backtest_linux_test.* TO 'quant_test'@'127.0.0.1';\n", text=True, check=True)
template = (root / 'deploy/linux/.env.test.example').read_text()
env_path.write_text(template.replace('REPLACE_WITH_GENERATED_PASSWORD', password).replace('REPLACE_WITH_GENERATED_TOKEN', admin))
env_path.chmod(0o600)
with open('/etc/nginx/quant.htpasswd', 'w') as output:
    subprocess.run(['htpasswd', '-niB', 'quant'], input=web + '\n', text=True, stdout=output, check=True)
Path('/etc/nginx/quant.htpasswd').chmod(0o640)
subprocess.run(['chown', 'root:www-data', '/etc/nginx/quant.htpasswd'], check=True)
credentials = Path('/root/quant-test-access.txt')
credentials.write_text(f'UI: http://192.168.171.140:8080\nAdmin: http://192.168.171.140:8081\nGateway user: quant\nGateway password: {web}\nAdmin API token: {admin}\n')
credentials.chmod(0o600)
print('Created isolated database/config. Access credentials stored in /root/quant-test-access.txt')
