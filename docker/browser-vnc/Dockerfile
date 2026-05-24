# Browser-VNC — a headed Chrome on a viewable VNC display for the human-in-the-loop
# browser handoff (solve a reCAPTCHA mid-run, then let browser_agent continue).
#
# Stack: Xvfb (virtual X display) + headed Google Chrome (with CDP on :9222 so
# Playwright/playwright-mcp drives THIS browser) + x11vnc (exposes the display as
# raw VNC on :5901) + websockify serving the noVNC web client on :6080 (so the
# dashboard can embed a real, clickable browser). supervisord runs all four.
#
# Opt-in: started only via the `browser-vnc` compose profile. Wiring the gateway
# noVNC proxy + the playwright-mcp --cdp-endpoint comes in the next phases.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    VNC_PORT=5901 \
    NOVNC_PORT=6080 \
    CDP_PORT=9222 \
    SCREEN_GEOMETRY=1600x900x24 \
    VNC_PASSWORD=starling

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc \
    novnc websockify \
    supervisor iproute2 \
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
command=/usr/bin/google-chrome --no-sandbox --disable-gpu --disable-software-rasterizer --disable-crashpad --disable-breakpad --no-first-run --no-default-browser-check --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=%(ENV_CDP_PORT)s --remote-allow-origins=* --user-data-dir=/home/browser/profile --window-position=0,0 --window-size=1600,900 --start-maximized about:blank
user=browser
environment=DISPLAY=":1",HOME="/home/browser"
autorestart=true
priority=20
startsecs=5
startretries=10
stdout_logfile=/tmp/chrome.log
stderr_logfile=/tmp/chrome-err.log

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
