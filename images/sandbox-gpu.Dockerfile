FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 agent

USER 1000:1000
WORKDIR /workspace
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
CMD ["sleep", "infinity"]
