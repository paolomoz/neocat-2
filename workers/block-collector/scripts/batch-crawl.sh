#!/bin/bash
# Batch crawl pending sites
# Usage: ./scripts/batch-crawl.sh [limit]

API_BASE="https://eds-block-collector.paolo-moz.workers.dev"
LIMIT=${1:-10}
DELAY=5  # seconds between crawls

echo "================================"
echo "EDS Block Collector - Batch Crawl"
echo "================================"
echo ""

# Get current stats
echo "Current stats:"
curl -s "$API_BASE/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"  Sites: {d['crawl']['sites_total']} ({d['crawl']['sites_pending']} pending)\")
print(f\"  Pages: {d['crawl']['pages_crawled']}\")
print(f\"  Blocks: {d['crawl']['blocks_extracted']}\")
"
echo ""

# Get pending sites
echo "Fetching pending sites..."
PENDING=$(curl -s "$API_BASE/sites?status=pending&limit=$LIMIT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
sites = d.get('data', [])
for s in sites:
    print(f\"{s['id']}|{s['domain']}\")
")

if [ -z "$PENDING" ]; then
    echo "No pending sites found."
    exit 0
fi

COUNT=$(echo "$PENDING" | wc -l | tr -d ' ')
echo "Found $COUNT pending sites to crawl"
echo ""

# Crawl each site
CRAWLED=0
PAGES=0
BLOCKS=0

echo "$PENDING" | while IFS='|' read -r SITE_ID DOMAIN; do
    echo "----------------------------------------"
    echo "Crawling: $DOMAIN"
    echo "Site ID: $SITE_ID"

    # Trigger crawl
    RESULT=$(curl -s -X POST "$API_BASE/crawler/crawl" \
        -H "Content-Type: application/json" \
        -d "{\"siteId\": \"$SITE_ID\"}" \
        --max-time 120 2>/dev/null)

    if echo "$RESULT" | grep -q '"success":true'; then
        PAGES_FOUND=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('pagesDiscovered',0))" 2>/dev/null || echo "0")
        BLOCKS_FOUND=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('blocksFound',0))" 2>/dev/null || echo "0")
        echo "  ✓ Pages discovered: $PAGES_FOUND"
        echo "  ✓ Blocks found: $BLOCKS_FOUND"
    else
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','Unknown error'))" 2>/dev/null || echo "Request failed")
        echo "  ✗ Error: $ERROR"
    fi

    echo "  Waiting ${DELAY}s..."
    sleep $DELAY
done

echo ""
echo "================================"
echo "Crawl batch complete!"
echo "================================"

# Show updated stats
echo ""
echo "Updated stats:"
curl -s "$API_BASE/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"  Sites: {d['crawl']['sites_total']} ({d['crawl']['sites_pending']} pending)\")
print(f\"  Pages: {d['crawl']['pages_crawled']}\")
print(f\"  Blocks: {d['crawl']['blocks_extracted']}\")
"
