# Sensor Server Deployment Guide

This guide covers deploying the sensor server to a VPS using Docker and Docker Compose.

## Prerequisites

- A VPS with:
  - Ubuntu 22.04 or later (or similar Linux distribution)
  - At least 1GB RAM
  - Docker and Docker Compose installed
  - A domain name pointing to your VPS (for SSL certificates)
  - Ports 80 and 443 open in firewall

## Initial VPS Setup

### 1. Install Docker and Docker Compose

```bash
# Update package list
sudo apt update

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to docker group (to run docker without sudo)
sudo usermod -aG docker $USER

# Log out and back in for group changes to take effect

# Install Docker Compose
sudo apt install docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

### 2. Set Up SSL Certificates with Let's Encrypt

```bash
# Install certbot
sudo apt install certbot

# Generate certificates (replace example.com with your domain)
sudo certbot certonly --standalone -d sensor.example.com

# Certificates will be created at:
# /etc/letsencrypt/live/sensor.example.com/fullchain.pem
# /etc/letsencrypt/live/sensor.example.com/privkey.pem
```

## Deployment Steps

### 1. Clone Your Repository

```bash
# SSH into your VPS
ssh user@your-vps-ip

# Clone the sensor_server repository
git clone https://github.com/YOUR_USERNAME/sensor_server.git
cd sensor_server
```

### 2. Configure Environment

```bash
# Copy the production environment template
cp .env.production .env

# Generate a secure API key
openssl rand -hex 32

# Edit .env and set your API key
nano .env
```

Edit `.env`:
```bash
SENSOR_API_KEY=your-generated-api-key-here
PORT=3000
```

### 3. Set Up SSL Certificates

```bash
# Create certs directory
mkdir -p certs

# Copy Let's Encrypt certificates
sudo cp /etc/letsencrypt/live/sensor.example.com/fullchain.pem certs/cert.pem
sudo cp /etc/letsencrypt/live/sensor.example.com/privkey.pem certs/key.pem

# Set proper permissions
sudo chown $USER:$USER certs/*.pem
chmod 644 certs/cert.pem
chmod 600 certs/key.pem
```

### 4. Create Data Directory

```bash
# Create directory for database persistence
mkdir -p data
```

### 5. Start the Application

First, log in to GitHub Container Registry (you'll need a Personal Access Token with `read:packages` scope):
```bash
# Log in to GHCR
echo $CR_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Then start the application:
```bash
# Pull the latest image
docker compose pull

# Start the service in detached mode
docker compose up -d

# Check logs
docker compose logs -f
```

### 6. Verify Deployment

```bash
# Check if container is running
docker compose ps

# Test HTTPS endpoint
curl https://sensor.example.com

# Check health status
docker compose ps
```

## Configure Sensor Reader

On your local machine where the sensor reader runs, update the `.env` file:

```bash
# In sensor_reader/.env
SENSOR_API_KEY=your-generated-api-key-here
```

Update the server URL when running the sensor reader:

```bash
cargo run -- --port /dev/ttyUSB0 --server-url https://sensor.example.com/api/readings
```

## Updating the Application

Since the image is built in CI, you just need to pull the new image:

```bash
cd ~/sensor_server

# Pull latest changes (for docker-compose.yml updates)
git pull origin master

# Pull the new Docker image
docker compose pull

# Restart the service
docker compose up -d
```

### View Logs

```bash
# Follow logs
docker compose logs -f

# View last 100 lines
docker compose logs --tail=100
```

## Rollback Procedure

If an update causes issues, you can revert to a specific image SHA:

1. Find the working SHA from your GitHub Actions logs or GHCR.
2. Edit `docker-compose.yml` to use that tag:
   ```yaml
   image: ghcr.io/YOUR_USERNAME/sensor_server:sha-XXXXXXX
   ```
3. Restart:
   ```bash
   docker compose up -d
   ```

## Database Management

### Backup Database

```bash
# Create backup
cp data/sensor_data.db data/sensor_data.db.backup-$(date +%Y%m%d)

# Or use docker cp
docker cp sensor-server:/app/data/sensor_data.db ./backup-$(date +%Y%m%d).db
```

### Restore Database

```bash
# Stop the service
docker compose down

# Restore backup
cp data/sensor_data.db.backup-20241127 data/sensor_data.db

# Restart service
docker compose up -d
```

## SSL Certificate Renewal

Let's Encrypt certificates expire every 90 days. Set up automatic renewal:

```bash
# Test renewal
sudo certbot renew --dry-run

# Set up automatic renewal with cron
sudo crontab -e

# Add this line to renew daily and copy to certs directory
0 0 * * * certbot renew --quiet && cp /etc/letsencrypt/live/sensor.example.com/fullchain.pem /home/$USER/sensor_server/certs/cert.pem && cp /etc/letsencrypt/live/sensor.example.com/privkey.pem /home/$USER/sensor_server/certs/key.pem && docker compose -f /home/$USER/sensor_server/docker-compose.yml restart
```

## Monitoring

### Check Container Status

```bash
docker compose ps
```

### View Resource Usage

```bash
docker stats sensor-server
```

### Check Disk Usage

```bash
# Check database size
du -h data/sensor_data.db

# Check Docker disk usage
docker system df
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs for errors
docker compose logs

# Verify environment variables
docker compose config

# Check file permissions
ls -la certs/
```

### SSL Certificate Issues

```bash
# Verify certificates exist and are readable
ls -la certs/
openssl x509 -in certs/cert.pem -text -noout

# Check certificate expiration
openssl x509 -in certs/cert.pem -noout -dates
```

### Database Locked Errors

```bash
# Stop the container
docker compose down

# Check for stale lock files
ls -la data/

# Remove lock files if present
rm data/*.db-shm data/*.db-wal

# Restart
docker compose up -d
```

### Port Already in Use

```bash
# Check what's using port 3000
sudo lsof -i :3000

# Change port in .env
echo "PORT=3001" >> .env

# Update docker-compose.yml port mapping if needed
# Then restart
docker compose down
docker compose up -d
```

## Security Best Practices

1. **Keep API Key Secret**: Never commit `.env` to git
2. **Regular Updates**: Keep Docker and system packages updated
3. **Firewall**: Only expose necessary ports (80, 443, SSH)
4. **Backups**: Regularly backup the database
5. **Monitoring**: Set up monitoring/alerting for downtime
6. **SSL Only**: Always use HTTPS in production

## Future Migration to Kubernetes

The Docker setup is designed to be K8s-friendly:
- Uses environment variables for configuration
- Stateless application (database on volume)
- Health checks configured
- Non-root user

When ready to migrate to Kubernetes, you'll need to create:
- Deployment manifest
- Service manifest
- ConfigMap for environment variables
- Secret for API key
- PersistentVolumeClaim for database
