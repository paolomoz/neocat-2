#!/bin/bash
# Extract blocks and score them for all complete sites
# Usage: ./scripts/extract-blocks.sh [limit]

API_BASE="https://eds-block-collector.paolo-moz.workers.dev"
LIMIT=${1:-20}
DELAY=3

echo "========================================"
echo "EDS Block Collector - Block Extraction"
echo "========================================"
echo ""

# Get current stats
echo "Current stats:"
curl -s "$API_BASE/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"  Sites complete: {d['crawl']['sites_complete']}\")
print(f\"  Blocks: {d['crawl']['blocks_extracted']}\")
print(f\"  By tier: Gold={d['blocks']['by_tier'].get('gold',0)}, Silver={d['blocks']['by_tier'].get('silver',0)}, Bronze={d['blocks']['by_tier'].get('bronze',0)}\")
"
echo ""

# Get complete sites
echo "Fetching complete sites (limit: $LIMIT)..."
SITES=$(curl -s "$API_BASE/sites?status=complete&limit=$LIMIT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
sites = d.get('data', [])
for s in sites:
    print(f\"{s['id']}|{s['domain']}\")
")

if [ -z "$SITES" ]; then
    echo "No complete sites found."
    exit 0
fi

COUNT=$(echo "$SITES" | wc -l | tr -d ' ')
echo "Processing $COUNT sites..."
echo ""

TOTAL_BLOCKS=0
TOTAL_SCORED=0

echo "$SITES" | while IFS='|' read -r SITE_ID DOMAIN; do
    echo "----------------------------------------"
    echo "Processing: $DOMAIN"

    # Extract blocks
    EXTRACT_RESULT=$(curl -s -X POST "$API_BASE/extractor/blocks" \
        -H "Content-Type: application/json" \
        -d "{\"siteId\": \"$SITE_ID\"}" \
        --max-time 60 2>/dev/null)

    if echo "$EXTRACT_RESULT" | grep -q '"success":true'; then
        BLOCKS=$(echo "$EXTRACT_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('blocksExtracted',0))" 2>/dev/null || echo "0")
        echo "  ✓ Extracted: $BLOCKS blocks"
    else
        echo "  ✗ Extraction failed"
        BLOCKS=0
    fi

    # Score blocks
    if [ "$BLOCKS" != "0" ]; then
        SCORE_RESULT=$(curl -s -X POST "$API_BASE/quality/score" \
            -H "Content-Type: application/json" \
            -d "{\"siteId\": \"$SITE_ID\"}" \
            --max-time 60 2>/dev/null)

        if echo "$SCORE_RESULT" | grep -q '"success":true'; then
            SCORED=$(echo "$SCORE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('blocksScored',0))" 2>/dev/null || echo "0")
            echo "  ✓ Scored: $SCORED blocks"
        else
            echo "  ✗ Scoring failed"
        fi
    fi

    sleep $DELAY
done

echo ""
echo "========================================"
echo "Extraction complete!"
echo "========================================"

# Show updated stats
echo ""
echo "Updated stats:"
curl -s "$API_BASE/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"  Blocks: {d['crawl']['blocks_extracted']}\")
print(f\"  By tier: Gold={d['blocks']['by_tier'].get('gold',0)}, Silver={d['blocks']['by_tier'].get('silver',0)}, Bronze={d['blocks']['by_tier'].get('bronze',0)}\")
print(f\"  Average quality: {d['blocks']['average_quality']:.1f}\")
"
