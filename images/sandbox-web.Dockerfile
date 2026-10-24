# anemone/sandbox-web: the standard sandbox plus a headless browser and common CLI tools.
# Python Playwright with Chromium, Node.js, jq, wget, zip/unzip, sqlite3.
FROM python:3.12-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates build-essential \
      nodejs npm jq wget zip unzip sqlite3 \
 && pip install playwright \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.cache \
 && useradd -m -u 1000 agent

USER 1000:1000
WORKDIR /workspace
# Chromium keeps its profile and cache under HOME, which is the writable /tmp in anemone.
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
CMD ["sleep", "infinity"]
