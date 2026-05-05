#!/bin/bash
# Check if today's menu data was successfully scraped

TODAY=$(TZ=America/New_York date '+%Y-%m-%d')
echo "Checking for menu data for: $TODAY"
echo ""

# Check log file
if [ -f ~/Library/Logs/nu-scrape.log ]; then
    echo "📋 Recent log entries:"
    grep "$TODAY" ~/Library/Logs/nu-scrape.log | tail -2
    echo ""
fi

# Check launchd status
echo "⏰ Launchd status:"
launchctl list | grep nudining
echo ""

# Verify launchd is loaded
if launchctl list | grep -q com.nudining.scrape; then
    echo "✓ Launchd job is loaded and scheduled"
else
    echo "✗ Launchd job is NOT loaded"
fi
