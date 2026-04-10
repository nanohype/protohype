# AWS Deployment Guide — spastic-memory

## Instance Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| Instance | t3.micro | t3.small |
| RAM | 1GB | 2GB |
| Storage | 8GB | 20GB |
| OS | Amazon Linux 2023 or Ubuntu 22.04 |

The sentence-transformers model (`all-MiniLM-L6-v2`) requires ~80MB download on first run and ~100MB RAM steady state. Total service footprint: ~200MB RAM.

---

## EC2 Security Group

Allow **inbound** only:
- Port 22 (SSH) from your IP
- **Do NOT open port 8765 to 0.0.0.0/0**

The memory service binds to `127.0.0.1:8765` by default. Agents on the same host access it directly. For agents on separate instances, use a VPC internal security group rule allowing port 8765 from the private subnet CIDR only.

---

## Quick Deploy

```bash
# 1. SSH into your EC2 instance
ssh -i your-key.pem ec2-user@your-instance-ip

# 2. Clone the repo
git clone https://github.com/nanohype/protohype.git
cd protohype/spastic-memory

# 3. Run installer
sudo bash deploy/install.sh

# 4. Verify
curl http://127.0.0.1:8765/api/v1/health
```

---

## Environment Variables

Create `/opt/spastic-memory/.env` to override defaults:

```env
SPASTIC_MEMORY_HOST=127.0.0.1
SPASTIC_MEMORY_PORT=8765
SPASTIC_MEMORY_DB_PATH=/workspace/.spastic/memory.db
SPASTIC_MEMORY_SEED_MD_PATH=/workspace/.spastic/memory.md
SPASTIC_MEMORY_EMBEDDING_MODEL=all-MiniLM-L6-v2
SPASTIC_MEMORY_SUMMARIZE_THRESHOLD=200
SPASTIC_MEMORY_SUMMARIZE_BATCH_SIZE=50
SPASTIC_MEMORY_SUMMARIZE_MIN_AGE_HOURS=24
```

---

## Operations

```bash
# Check status
systemctl status spastic-memory

# View logs (live)
journalctl -u spastic-memory -f

# Restart after config change
systemctl restart spastic-memory

# Stop
systemctl stop spastic-memory

# Backup the database
cp /workspace/.spastic/memory.db /workspace/.spastic/memory.db.bak-$(date +%Y%m%d)
```

---

## Updating

```bash
cd protohype
git pull
sudo bash spastic-memory/deploy/install.sh
```

The installer is idempotent — safe to re-run.

---

## Backup Strategy (minimal)

Since the solopreneur constraint means no ops overhead:
- Add a daily cron to copy `memory.db` to S3:

```bash
# /etc/cron.daily/backup-spastic-memory
#!/bin/bash
aws s3 cp /workspace/.spastic/memory.db s3://your-bucket/spastic-memory/memory-$(date +%Y%m%d).db
```

SQLite WAL mode ensures the copy is consistent without stopping the service.
