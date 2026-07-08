# Computer Desktop — ephemeral desktop environment for computer-use agents.
# Provides a VNC-accessible XFCE desktop with basic utilities.
#
# Usage: docker compose -f docker-compose.computer.yml up computer-desktop

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    VNC_PORT=5901 \
    VNC_RESOLUTION=1920x1080 \
    VNC_COLOR_DEPTH=24

# Core desktop & VNC + VS Code dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xfce4 xfce4-terminal \
    tigervnc-standalone-server tigervnc-common \
    dbus-x11 \
    x11-utils xdotool xclip iproute2 \
    supervisor \
    wget curl ca-certificates \
    fonts-liberation fonts-dejavu \
    python3 python3-pip \
    # VS Code runtime dependencies (must be present before dpkg -i)
    libasound2t64 libnspr4 libnss3 xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# VS Code (headless or full, for agent-in-vscode scenarios)
RUN wget -qO /tmp/vscode.deb 'https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64' \
    && dpkg -i /tmp/vscode.deb \
    && rm /tmp/vscode.deb

# Non-root user
RUN useradd -m -s /bin/bash agent \
    && mkdir -p /home/agent/.vnc /home/agent/workspace

# Ownership
RUN chown -R agent:agent /home/agent

# Supervisor config for VNC + XFCE
COPY <<'EOF' /etc/supervisor/conf.d/desktop.conf
[supervisord]
nodaemon=true
logfile=/tmp/supervisord.log

[program:vnc]
command=vncserver -fg :1 -geometry %(ENV_VNC_RESOLUTION)s -depth %(ENV_VNC_COLOR_DEPTH)s -localhost no -SecurityTypes VncAuth -rfbport %(ENV_VNC_PORT)s
user=agent
autorestart=true
stdout_logfile=/tmp/vnc.log
stderr_logfile=/tmp/vnc-err.log

[program:xfce]
command=/usr/bin/startxfce4
user=agent
environment=DISPLAY=":1"
autorestart=true
stdout_logfile=/tmp/xfce.log
stderr_logfile=/tmp/xfce-err.log
EOF

# Entrypoint: generate VNC password at runtime (allows VNC_PASSWORD override),
# then start supervisord.  Ubuntu 24.04 tigervnc-common no longer ships
# vncpasswd / tigervncpasswd, so we generate the 8-byte DES password file
# with pure Python (no external deps).
RUN cat <<'ENTRY' > /usr/local/bin/entrypoint.sh
#!/bin/sh
set -e
# Refuse to boot with the well-known default VNC password when the desktop port
# is published to a non-loopback interface — that combination is a trivial
# remote-desktop takeover. On localhost-only (the default) the demo password is
# allowed but warned about. Changing VNC_PASSWORD also requires updating
# computerUse.nodes.desktop.credentials in config so the swarm can still connect.
VNC_PW="${VNC_PASSWORD:-starling}"
case "${SAI_BIND_HOST:-127.0.0.1}" in
  127.0.0.1|localhost|::1) BOUND_LOCAL=1 ;;
  *) BOUND_LOCAL=0 ;;
esac
if [ "$VNC_PW" = "starling" ]; then
  if [ "$BOUND_LOCAL" = "0" ]; then
    echo "FATAL: VNC desktop is bound to a non-loopback interface (SAI_BIND_HOST=${SAI_BIND_HOST}) with the default password 'starling'." >&2
    echo "       Set a strong VNC_PASSWORD (and the matching computerUse.nodes.desktop.credentials in config) before exposing it." >&2
    exit 1
  fi
  echo "WARNING: VNC desktop is using the default password 'starling' — safe only because the port is bound to localhost. Set VNC_PASSWORD before exposing it via SAI_BIND_HOST." >&2
fi
python3 -c "
import os, struct, sys
pw = os.environ.get('VNC_PASSWORD', 'starling').encode('latin-1')[:8].ljust(8, b'\x00')
# VNC reverses the bits of each key byte before DES
key = bytes(int('{:08b}'.format(b)[::-1], 2) for b in pw)
# DES-ECB encrypt 8 zero bytes — minimal pure-Python DES (single block)
def des_encrypt(key8, block8):
    def bits(bs): return [(bs[i>>3]>>(7-(i&7)))&1 for i in range(len(bs)*8)]
    def frombits(b):
        out=bytearray(len(b)//8)
        for i,v in enumerate(b):
            if v: out[i>>3]|=1<<(7-(i&7))
        return bytes(out)
    PC1=[57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4]
    PC2=[14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32]
    IP=[58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7]
    FP=[40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25]
    E=[32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1]
    S=[
     [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
     [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
     [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
     [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
     [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
     [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
     [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
     [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,2,0,14,9,11,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,11,14,4,1,13,2,0,11,3,8,9,4,5,10,12,7],
    ]
    P=[16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25]
    SHIFTS=[1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1]
    kb=bits(key8)
    k=[kb[i-1]for i in PC1]
    C,D=k[:28],k[28:]
    subkeys=[]
    for s in SHIFTS:
        C=C[s:]+C[:s]; D=D[s:]+D[:s]
        subkeys.append([((C+D)[i-1])for i in PC2])
    mb=bits(block8)
    m=[mb[i-1]for i in IP]
    L,R=m[:32],m[32:]
    for sk in subkeys:
        eR=[R[i-1]for i in E]
        x=[eR[i]^sk[i]for i in range(48)]
        sout=[]
        for j in range(8):
            chunk=x[j*6:(j+1)*6]
            row=(chunk[0]<<1)|chunk[5]
            col=(chunk[1]<<3)|(chunk[2]<<2)|(chunk[3]<<1)|chunk[4]
            val=S[j][row*16+col]
            sout+=[(val>>(3-b))&1 for b in range(4)]
        f=[sout[i-1]for i in P]
        L,R=R,[L[i]^f[i]for i in range(32)]
    combined=R+L
    cipher=[combined[i-1]for i in FP]
    return frombits(cipher)
with open('/home/agent/.vnc/passwd','wb') as f:
    f.write(des_encrypt(key, b'\x00'*8))
" && chmod 600 /home/agent/.vnc/passwd
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/desktop.conf
ENTRY

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5901

USER agent
WORKDIR /home/agent/workspace

CMD ["/usr/local/bin/entrypoint.sh"]
