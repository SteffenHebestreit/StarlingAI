# Minimal sandbox for tool execution
# This image is launched by the shell_exec tool with --network=none --read-only --cap-drop=ALL
FROM alpine:3.19

# Install only essential tools
RUN apk add --no-cache \
    bash \
    curl \
    wget \
    git \
    jq \
    python3 \
    py3-pip \
    nodejs \
    npm \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN adduser -D -s /bin/sh sandbox
USER sandbox

WORKDIR /workspace
CMD ["/bin/sh"]
