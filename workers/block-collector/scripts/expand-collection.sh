#!/bin/bash
# Full expansion pipeline: add sites + crawl them
# Usage: ./scripts/expand-collection.sh [crawl-limit]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWL_LIMIT=${1:-20}

echo "========================================"
echo "EDS Block Collection - Full Expansion"
echo "========================================"
echo ""

# Step 1: Add known sites
echo "Step 1: Adding known EDS sites..."
echo "----------------------------------------"
bash "$SCRIPT_DIR/add-sites.sh"

echo ""
echo ""

# Step 2: Crawl pending sites
echo "Step 2: Crawling pending sites (limit: $CRAWL_LIMIT)..."
echo "----------------------------------------"
bash "$SCRIPT_DIR/batch-crawl.sh" "$CRAWL_LIMIT"

echo ""
echo "========================================"
echo "Expansion complete!"
echo "========================================"
