# Deepfreeze Examples

This directory contains example configuration files for scheduling automatic deepfreeze rotation.

## Files

| File | Description |
|------|-------------|
| `deepfreeze-rotate.service` | systemd service unit for running rotation |
| `deepfreeze-rotate.timer` | systemd timer for scheduling rotation |
| `crontab-example.txt` | crontab examples for various scheduling options |

## systemd (Recommended)

For systems using systemd, use the service and timer files together:

```bash
# Copy files to systemd directory
sudo cp deepfreeze-rotate.service /etc/systemd/system/
sudo cp deepfreeze-rotate.timer /etc/systemd/system/

# Edit the service file to adjust paths and user
sudo vim /etc/systemd/system/deepfreeze-rotate.service

# Enable and start the timer
sudo systemctl daemon-reload
sudo systemctl enable deepfreeze-rotate.timer
sudo systemctl start deepfreeze-rotate.timer

# Verify timer is active
systemctl list-timers deepfreeze-rotate.timer
```

### Manual Run

```bash
sudo systemctl start deepfreeze-rotate.service
```

### View Logs

```bash
journalctl -u deepfreeze-rotate.service
```

## cron

For systems using cron, see `crontab-example.txt` for various scheduling options.

```bash
# Edit user crontab
crontab -e

# Add the line (runs 1st of every month at 2 AM):
0 2 1 * * /usr/local/bin/deepfreeze --config /etc/deepfreeze/config.yml rotate --keep 6
```

## Configuration

Before using these examples, ensure:

1. Deepfreeze is installed and accessible at the path specified (default: `/usr/local/bin/deepfreeze`)
2. Configuration file exists at the specified path (default: `/etc/deepfreeze/config.yml`)
3. The user running the service has appropriate permissions and AWS credentials configured
