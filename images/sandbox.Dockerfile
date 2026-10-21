FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 agent

USER 1000:1000
WORKDIR /workspace
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
CMD ["sleep", "infinity"]
