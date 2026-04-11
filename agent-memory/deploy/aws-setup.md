# AWS Deployment Guide for Agent Memory

## Architecture Overview

Agent Memory runs as a single-process service with an embedded SQLite database. It is designed for deployment on a single EC2 instance or container, not for horizontal scaling.

## EC2 Deployment

### Instance Selection

- **Minimum**: t3.small (2 vCPU, 2 GB RAM)
- **Recommended**: t3.medium (2 vCPU, 4 GB RAM) for larger embedding models
- The sentence-transformers model loads into memory at startup (~250 MB for MiniLM)

### Security Group

```
Inbound:
  - TCP 22   (SSH, your IP only)
  - TCP 8765 (Agent Memory, from your VPC CIDR or specific SGs)

Outbound:
  - All traffic (for pip installs, model downloads)
```

### Setup Steps

1. **Launch EC2 instance** with Ubuntu 22.04+ AMI

2. **Install Python 3.11+**:
   ```bash
   sudo apt update && sudo apt install -y python3.11 python3.11-venv
   ```

3. **Deploy the service**:
   ```bash
   # Copy the project to the instance
   scp -r ./agent-memory ec2-user@<instance-ip>:/tmp/

   # SSH in and run the installer
   ssh ec2-user@<instance-ip>
   cd /tmp/agent-memory
   sudo bash deploy/install.sh
   ```

4. **Configure the service**:
   ```bash
   sudo systemctl edit agent-memory
   # Add overrides:
   # [Service]
   # Environment=AGENT_MEMORY_API_KEY=your-secret-key-here
   # Environment=AGENT_MEMORY_HOST=0.0.0.0
   ```

5. **Start and verify**:
   ```bash
   sudo systemctl start agent-memory
   curl http://127.0.0.1:8765/api/v1/health
   ```

### EBS Volume

- Use a gp3 volume for the data directory
- Minimum 10 GB (SQLite DB + model cache)
- Mount at `/var/lib/agent-memory` if using a separate volume

### Backups

SQLite with WAL mode supports safe file-level backups:

```bash
# Simple backup via cron
0 */6 * * * sqlite3 /var/lib/agent-memory/memory.db ".backup /var/lib/agent-memory/backups/memory-$(date +\%Y\%m\%d-\%H\%M).db"
```

Or use EBS snapshots for the entire data volume.

## ECS / Fargate Deployment

Agent Memory can run in a container, but the SQLite database must be on persistent storage.

### Dockerfile

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir .
ENV AGENT_MEMORY_HOST=0.0.0.0
ENV AGENT_MEMORY_PORT=8765
ENV AGENT_MEMORY_DB_PATH=/data/memory.db
EXPOSE 8765
CMD ["agent-memory"]
```

### EFS for Persistence

- Create an EFS filesystem in the same VPC
- Mount it to the container at `/data`
- This allows the SQLite database to persist across container restarts

### Task Definition Notes

- **CPU**: 512 (0.5 vCPU) minimum, 1024 recommended
- **Memory**: 2048 MB minimum (embedding model needs ~1 GB)
- **Health check**: `curl -f http://localhost:8765/api/v1/health`

## Networking

### Internal Service (Recommended)

Keep agent-memory on a private subnet. Other agents connect via:
- VPC internal DNS
- Service discovery (Cloud Map)
- ALB internal listener

### If Public Access Needed

Place behind an ALB with:
- HTTPS listener (ACM certificate)
- Target group pointing to port 8765
- API key authentication enabled (`AGENT_MEMORY_API_KEY`)

## Monitoring

### CloudWatch

- Forward journald logs to CloudWatch via the CloudWatch agent
- Set up alarms on:
  - CPU > 80% sustained
  - Disk usage > 80%
  - Health endpoint failures

### Health Check

```bash
# Simple monitoring script
curl -sf http://127.0.0.1:8765/api/v1/health | jq '.status' | grep -q '"ok"' || alert
```

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| t3.small (on-demand) | ~$15 |
| t3.small (reserved 1yr) | ~$9 |
| gp3 10GB | ~$1 |
| Data transfer (internal) | ~$0 |
| **Total** | **~$10-16** |
