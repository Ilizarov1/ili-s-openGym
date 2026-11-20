# NestJS A5 验收执行单

在 Windows 用 PowerShell 操作。用两套独立 Compose 项目和合成账号完成 A5.1 HTTPS、A5.2 子路径、A5.3 局域网。真实 Passkey、远端 CI 和正式部署分别验收。

## 1. 准备候选镜像和工作目录

从仓库根目录执行。Docker 优先选能从 Windows 发布端口的 Docker Desktop context。WSL 仅用已有 OpenSSL 签发测试证书。

```powershell
docker context show
docker info --format '{{.Name}} {{.OperatingSystem}}'
docker compose version
wsl.exe -d Ubuntu -- openssl version
docker image inspect --format '{{.Id}}' opengym-handoff-api:nest-default opengym-handoff-web:test
Get-NetTCPConnection -LocalPort 18443,18085 -State Listen -ErrorAction SilentlyContinue

$a5Run = [guid]::NewGuid().ToString('N').Substring(0, 8)
$a5Dir = Join-Path $env:LOCALAPPDATA "openGym-a5-$a5Run"
$a5TlsProject = "opengym-a5-tls-$a5Run"
$a5LanProject = "opengym-a5-lan-$a5Run"
New-Item -ItemType Directory -Path $a5Dir, (Join-Path $a5Dir 'tls'), (Join-Path $a5Dir 'evidence') | Out-Null
```

API 和 Web 的预期镜像 ID 依次是：

- API：sha256:2eb529cbc7e68dd34c091973d0949b48c0c7cb285bb5addad9cff0b7593e1185
- Web：sha256:64c9599ae3274ba889bd3d0ce6c762da0f8e7a6345422ec467257216981adb2d

镜像缺失或 ID 不符时，从候选提交 1f81182e194df3a28fe8797145645bd83e9158e7 导出源码，用独立标签重建所需镜像，记录 SHA 和新镜像 ID，并替换下文环境文件里的标签。若端口已占用，改用空闲高位端口，同步调整所有端口映射、ORIGIN 和访问 URL。[镜像和构建记录](ACCEPTANCE.md)

```powershell
# 仅在需要重建时执行，当前目录为仓库根目录。
$a5Source = Join-Path $a5Dir 'source'
$a5Archive = Join-Path $a5Dir 'source.tar'
New-Item -ItemType Directory -Path $a5Source | Out-Null
git archive --format=tar --output=$a5Archive 1f81182e194df3a28fe8797145645bd83e9158e7
if ($LASTEXITCODE -ne 0) { throw '候选源码导出失败' }
tar.exe -xf $a5Archive -C $a5Source
if ($LASTEXITCODE -ne 0) { throw '候选源码解包失败' }
docker build --target default -t "opengym-a5-api:$a5Run" "$a5Source/api"
docker build -f "$a5Source/web/Dockerfile" -t "opengym-a5-web:$a5Run" $a5Source
```

## 2. 基础 Compose 配置

用 UTF-8 无 BOM 把以下文件保存到 $a5Dir。两次执行使用不同项目名，分别创建测试数据卷。API 通过 Compose 内部网络提供给 Web。

**compose.yml**

```yaml
services:
  api:
    image: ${A5_API_IMAGE}
    pull_policy: never
    stop_grace_period: 15s
    environment:
      PORT: "3000"
      DATA_DIR: /data
      ORIGIN: "${A5_ORIGIN}"
      RP_ID: "${A5_RP_ID}"
      BASE_PATH: "${A5_BASE_PATH:-}"
      TRUST_PROXY: "1"
      PASSWORD_LOGIN: "1"
      COACH_DISABLED: "1"
    volumes:
      - a5-data:/data
  web:
    image: ${A5_WEB_IMAGE}
    pull_policy: never
    depends_on:
      - api
    environment:
      NGINX_PORT: "80"
      BACKEND: api
      PORT: "3000"
      RESOLVER: 127.0.0.11
      BASE_PATH: "${A5_BASE_PATH:-}"
      MEDIA_UPLOAD_MAX: 48m
volumes:
  a5-data:
```

## 3. A5.1 HTTPS 与 A5.2 子路径

外部 URL 为 https://localhost:18443/gym/。外层 Nginx 保留 /gym 前缀，内层 Web 按 BASE_PATH 路由。ORIGIN 包含外部端口，RP_ID 只填写主机名。保持应用的 Cookie 属性。[子路径部署说明](../SELF_HOSTING.md#serving-opengym-under-a-subpath)

**tls.env**

```dotenv
A5_API_IMAGE=opengym-handoff-api:nest-default
A5_WEB_IMAGE=opengym-handoff-web:test
A5_ORIGIN=https://localhost:18443
A5_RP_ID=localhost
A5_BASE_PATH=/gym
```

**compose.tls.yml**

```yaml
services:
  edge:
    image: nginxinc/nginx-unprivileged:1.30.6-alpine
    depends_on:
      - web
    ports:
      - "127.0.0.1:18443:8443"
    volumes:
      - ./edge.conf:/etc/nginx/conf.d/default.conf:ro
      - ./tls/server.crt:/etc/nginx/server.crt:ro
      - ./tls/server.key:/etc/nginx/server.key:ro
```

**edge.conf**

```nginx
server {
    listen 8443 ssl;
    server_name localhost;
    absolute_redirect off;
    ssl_certificate /etc/nginx/server.crt;
    ssl_certificate_key /etc/nginx/server.key;
    client_max_body_size 48m;

    location = /gym {
        return 308 /gym/$is_args$args;
    }
    location /gym/ {
        proxy_pass http://web:80;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        return 404;
    }
}
```

**tls/localhost.ext**

```ini
subjectAltName=DNS:localhost
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
```

从创建目录的同一 PowerShell 会话运行。证书只用于本次测试。

```powershell
Set-Location $a5Dir
Push-Location (Join-Path $a5Dir 'tls')
try {
    wsl.exe -d Ubuntu -- openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7 -subj "/CN=OpenGym A5 $a5Run" -keyout ca.key -out ca.crt -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
    if ($LASTEXITCODE -ne 0) { throw '生成测试 CA 失败' }
    wsl.exe -d Ubuntu -- openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout server.key -out server.csr
    if ($LASTEXITCODE -ne 0) { throw '生成证书请求失败' }
    wsl.exe -d Ubuntu -- openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 7 -sha256 -extfile localhost.ext
    if ($LASTEXITCODE -ne 0) { throw '签发服务端证书失败' }
    wsl.exe -d Ubuntu -- openssl x509 -in ca.crt -outform DER -out ca.cer
    if ($LASTEXITCODE -ne 0) { throw '转换 Windows CA 文件失败' }
} finally {
    Pop-Location
}

$a5Tls = @('--env-file','tls.env','-p',$a5TlsProject,'-f','compose.yml','-f','compose.tls.yml')
docker compose @a5Tls config
```

确认配置中只有 edge 发布回环端口，卷名属于本次项目。若已有测试浏览器信任该 CA，直接用该浏览器。否则将 CA 临时导入 Windows 当前用户信任库，记录证书指纹以便清理。若系统要求确认，请用户处理系统弹窗。若策略限制导入，仍可用 curl 指定 CA 验证 TLS，浏览器验收记录实际阻塞。

```powershell
docker compose @a5Tls up -d --no-build
docker compose @a5Tls ps
curl.exe --cacert "$a5Dir/tls/ca.crt" -fsS https://localhost:18443/gym/api/health
curl.exe --cacert "$a5Dir/tls/ca.crt" -fsS https://localhost:18443/gym/api/config
curl.exe --cacert "$a5Dir/tls/ca.crt" -sS -D - -o NUL https://localhost:18443/gym
curl.exe --cacert "$a5Dir/tls/ca.crt" -sS -o NUL -w '%{http_code}' https://localhost:18443/api/health

# 仅当浏览器需要导入测试 CA 时执行。
$a5TrustedCa = Import-Certificate -FilePath "$a5Dir/tls/ca.cer" -CertStoreLocation Cert:\CurrentUser\Root
$a5TrustedCa.Thumbprint | Set-Content "$a5Dir/evidence/ca-thumbprint.txt"
```

| 编号 | 动作和通过条件 | 证据 |
| --- | --- | --- |
| A5.1 | 证书链和主机名校验通过。/gym/api/health 返回 200 JSON，ok 与 writable 为 true。/gym/api/config 返回 200 JSON。浏览器打开 /gym/，证书有效。 | 脱敏响应、浏览器安全面板 |
| A5.2 | /gym 返回 308，Location 为 /gym/。/api/health 返回 404。用密码新建测试账号，退出再登录，刷新后会话有效。保存一笔合成训练并重读。浏览器实际加载的 JS/CSS 走 /gym/assets/，应用请求走 /gym/api/，均成功。 | 状态码、实际请求路径、训练回读；会话 Cookie 只记录名称及属性 |

健康端点未就绪时查本项目日志再重试。页面可开但 API 404 时核对外层 proxy_pass 无尾斜杠、Web BASE_PATH 为 /gym。会话丢失时检查 ORIGIN、Cookie 和浏览器报错。HTTPS 会话预期是 __Host-gymsid，带 Secure 和 Path=/。

## 4. A5.3 局域网访问与 RN 同步

用可信局域网和临时账号测试 HTTP。服务在本机运行，设备通过 Wi-Fi 直连。先用以下命令找 Windows 网卡地址。

```powershell
Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    Select-Object InterfaceAlias, IPv4Address, IPv4DefaultGateway
```

选手机所在 Wi-Fi 或同一路由器下 Windows 物理网卡的 IPv4。下方 192.168.1.20 的两处都换成实际值。HTTP 使用密码登录，RP_ID 保留 localhost，浏览器访问地址必须与 ORIGIN 一致。

**lan.env**

```dotenv
A5_API_IMAGE=opengym-handoff-api:nest-default
A5_WEB_IMAGE=opengym-handoff-web:test
A5_LAN_IP=192.168.1.20
A5_ORIGIN=http://192.168.1.20:18085
A5_RP_ID=localhost
A5_BASE_PATH=
```

**compose.lan.yml**

```yaml
services:
  web:
    ports:
      - "${A5_LAN_IP}:18085:80"
```

```powershell
$a5Lan = @('--env-file','lan.env','-p',$a5LanProject,'-f','compose.yml','-f','compose.lan.yml')
docker compose @a5Lan config
```

确认仅 Web 发布指定局域网地址的端口，且卷名与 HTTPS 项目不同，再启动。

```powershell
docker compose @a5Lan up -d --no-build
docker compose @a5Lan ps
$a5LanOrigin = ((Get-Content lan.env | Where-Object { $_ -like 'A5_ORIGIN=*' }) -split '=',2)[1]
curl.exe -fsS "$a5LanOrigin/api/health"
curl.exe -fsS "$a5LanOrigin/api/config"
```

1. 手机连同一 Wi-Fi，在浏览器打开实际的局域网 URL 加 /api/health，确认返回 200 JSON。再打开站点，以密码创建测试账号，并在 Web 创建一套测试计划。
2. 用备用 Android 设备或专用测试安装。APK 可用仓库内 mobile-rn/dist/openGym-RN-0.1.6-five-tab.apk，SHA-256 应为 A03A936B6C4197CD3BC308AEE89D3A45BC0588C3A28F7F61A124BE9F3F341DEF。需要用户拿手机时，一次告知 Wi-Fi、URL 和操作步骤。[APK 记录](HANDOFF.md)
3. 在登录的 Web 生成配对码。RN 手输带 http:// 的实际局域网地址和配对码，确认拉到测试计划。完成一组并保存，从设置立即同步。Web 刷新后查到同一训练，再同步一次确认无重复。可在电脑 Web 生成配对码，RN 始终走手机 Wi-Fi 直连。
4. 记录手机型号、APK 哈希、脱敏截图，以及计划拉取和训练回读结果。独立设备直连完成这三项才记 A5.3 通过。模拟器端口转发可辅助定位。

本机可达而手机超时时，检查 Docker 端口绑定、Windows 网络配置文件与入站规则、手机是否同网及 Wi-Fi 客户端隔离。若是 WSL 内的独立 Docker daemon 导致无法绑定 Windows 网卡，优先切现有可用的 Docker Desktop context，再核对镜像。确需 Windows 防火墙规则或端口转发时，交由具备授权的人操作。保留已完成的证据，并记录剩余阻塞。这些步骤可使用现有普通用户权限执行，只有系统配置或工具安装可能涉及提权。

## 5. 记录与收尾

在 $a5Dir/evidence 记录候选 SHA、镜像 ID、Docker context、时间、设备、三个编号的预期和实际、通过／失败／待验证、证据路径及阻塞。保存相关脱敏日志。报告中只保留 Cookie 名和属性，省略密码、配对码、Cookie 值及 Bearer。将摘要回填 [候选分支验收记录](ACCEPTANCE.md) 阶段 4 的 A5；若工作区仍为阶段 0–3 版本，先在证据目录交付结果并标明回填分支 nestjs-phase4-work。

```powershell
# 只对本次实际创建的项目执行对应命令，从 $a5Dir 运行。
docker compose @a5Lan down
docker compose @a5Tls down
if ($a5TrustedCa -and $a5TrustedCa.Thumbprint) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\Root\$($a5TrustedCa.Thumbprint)"
}
Remove-Item -LiteralPath "$a5Dir/tls/ca.key", "$a5Dir/tls/server.key" -ErrorAction SilentlyContinue
```

合成数据卷保留供复验。若本轮添加过临时端口转发或防火墙规则，由操作人恢复本轮变更。
