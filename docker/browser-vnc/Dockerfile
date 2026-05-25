# Browser-VNC — a headed Chrome on a viewable VNC display for the human-in-the-loop
# browser handoff (solve a reCAPTCHA mid-run, then let browser_agent continue).
#
# Stack: Xvfb (virtual X display) + headed Google Chrome (CDP) + a socat forwarder
# that re-exposes CDP off localhost + x11vnc (raw VNC on :5901) + websockify
# serving the noVNC web client on :6080. supervisord runs all five.
#
# Why nginx: modern Chrome ALWAYS binds the DevTools port to 127.0.0.1 (ignores
# --remote-debugging-address) AND rejects /json requests whose Host header is a
# hostname ("not an IP address or localhost" — DNS-rebinding protection). So the
# Playwright MCP in another container can't reach CDP via browser-vnc:9222
# directly. Chrome listens on 127.0.0.1:$CDP_INTERNAL_PORT (9223); nginx listens
# on 0.0.0.0:$CDP_PORT (9222) and (a) rewrites the inbound Host to localhost so
# Chrome accepts it, and (b) rewrites the webSocketDebuggerUrl in /json responses
# back to browser-vnc:9222 so the client's follow-up WS connect returns here.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    VNC_PORT=5901 \
    NOVNC_PORT=6080 \
    CDP_PORT=9222 \
    CDP_INTERNAL_PORT=9223 \
    SCREEN_GEOMETRY=1600x900x24 \
    VNC_PASSWORD=starling

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc \
    novnc websockify \
    supervisor iproute2 nginx \
    wget curl ca-certificates gnupg \
    fonts-liberation fonts-dejavu \
    libasound2t64 libnspr4 libnss3 libxss1 libgbm1 xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Google Chrome stable (CDP-capable; Playwright connects over the DevTools proto).
RUN wget -qO /tmp/chrome.deb 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb' \
    && (dpkg -i /tmp/chrome.deb || apt-get update && apt-get install -y --no-install-recommends -f) \
    && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash browser && mkdir -p /home/browser/profile && chown -R browser:browser /home/browser

# noVNC convenience: serve vnc.html as index.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html || true

COPY <<'EOF' /etc/supervisor/conf.d/browser.conf
[supervisord]
nodaemon=true
logfile=/tmp/supervisord.log

[program:xvfb]
command=/usr/bin/Xvfb :1 -screen 0 %(ENV_SCREEN_GEOMETRY)s -ac +extension RANDR
autorestart=true
priority=10
stdout_logfile=/tmp/xvfb.log
stderr_logfile=/tmp/xvfb-err.log

[program:chrome]
# --remote-debugging-address=0.0.0.0 is ignored for BINDING (Chrome still binds
# 127.0.0.1) but it disables the DNS-rebinding Host-header check, so requests
# arriving via socat with Host: browser-vnc:9222 are accepted.
command=/usr/bin/google-chrome --no-sandbox --disable-gpu --disable-software-rasterizer --disable-crashpad --disable-breakpad --no-first-run --no-default-browser-check --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=%(ENV_CDP_INTERNAL_PORT)s --remote-allow-origins=* --user-data-dir=/home/browser/profile --window-position=0,0 --window-size=1600,900 --start-maximized about:blank
user=browser
environment=DISPLAY=":1",HOME="/home/browser"
autorestart=true
priority=20
startsecs=5
startretries=10
stdout_logfile=/tmp/chrome.log
stderr_logfile=/tmp/chrome-err.log

# Re-expose Chrome's localhost-only CDP off-localhost with Host rewriting so the
# Playwright MCP (a separate container) can connect via browser-vnc:9222.
[program:cdp-proxy]
command=/usr/sbin/nginx -g "daemon off;"
autorestart=true
priority=25
startretries=30
stdout_logfile=/tmp/cdp-proxy.log
stderr_logfile=/tmp/cdp-proxy-err.log

[program:x11vnc]
command=/usr/bin/x11vnc -display :1 -rfbauth /etc/x11vnc.pass -forever -shared -rfbport %(ENV_VNC_PORT)s -noxdamage -repeat
autorestart=true
priority=30
stdout_logfile=/tmp/x11vnc.log
stderr_logfile=/tmp/x11vnc-err.log

[program:novnc]
command=/usr/bin/websockify --web=/usr/share/novnc %(ENV_NOVNC_PORT)s localhost:%(ENV_VNC_PORT)s
autorestart=true
priority=40
stdout_logfile=/tmp/novnc.log
stderr_logfile=/tmp/novnc-err.log
EOF

# nginx CDP proxy: 0.0.0.0:9222 → 127.0.0.1:9223 with Host rewrite + ws-URL
# rewrite (see the header note). Host/ports are fixed by compose so they're
# hardcoded here. Remove the default :80 site to keep nginx focused.
RUN rm -f /etc/nginx/sites-enabled/default
COPY <<'NGINX' /etc/nginx/conf.d/cdp.conf
server {
    listen 9222;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:9223;
        proxy_set_header Host localhost:9223;     # Chrome accepts localhost Host
        proxy_set_header Accept-Encoding "";       # keep /json plain so sub_filter works
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # CDP WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;

        # Chrome builds webSocketDebuggerUrl from the (rewritten) Host, so /json/*
        # responses point at localhost:9223. Rewrite them to the address the
        # Playwright MCP actually dialed so its WS connect comes back here.
        sub_filter "localhost:9223" "browser-vnc:9222";
        sub_filter "127.0.0.1:9223" "browser-vnc:9222";
        sub_filter_once off;
        sub_filter_types application/json;
    }
}
NGINX

# Entrypoint: (re)generate the VNC password from $VNC_PASSWORD, then run supervisord.
RUN cat <<'ENTRY' > /usr/local/bin/entrypoint.sh
#!/bin/sh
set -e
x11vnc -storepasswd "${VNC_PASSWORD:-starling}" /etc/x11vnc.pass >/dev/null 2>&1
chmod 644 /etc/x11vnc.pass
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/browser.conf
ENTRY
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5901 6080 9222

CMD ["/usr/local/bin/entrypoint.sh"]
