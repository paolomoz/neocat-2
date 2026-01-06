#!/bin/bash
# Add EDS sites to the collector
# Usage: ./scripts/add-sites.sh [sites-file]
# If no file provided, uses built-in list of known EDS sites

API_BASE="https://eds-block-collector.paolo-moz.workers.dev"

# Built-in list of known high-quality EDS sites
KNOWN_SITES="
main--bacom--adobecom.aem.live
main--business-website--adobe.aem.live
main--cc--adobecom.aem.live
main--dc--adobecom.aem.live
main--express-website--adobe.aem.live
main--firefly--adobecom.aem.live
main--photoshop--adobecom.aem.live
main--illustrator--adobecom.aem.live
main--premiere--adobecom.aem.live
main--aftereffects--adobecom.aem.live
main--stock--adobecom.aem.live
main--milo--adobecom.aem.live
main--blog--adobe.aem.live
main--helix-website--adobe.aem.live
main--aem-boilerplate--adobe.aem.live
main--aem-block-collection--adobe.aem.live
main--wknd--adobe.aem.live
main--fedex--hlxsites.aem.live
main--mammut--hlxsites.aem.live
main--pgatour--pgatour.aem.live
main--servicenow--hlxsites.aem.live
main--danaher--hlxsites.aem.live
main--bamboohr--hlxsites.aem.live
main--walgreens--hlxsites.aem.live
main--honeywell--hlxsites.aem.live
main--asus--hlxsites.aem.live
main--vg-volvotrucks-us--volvogroup.aem.live
main--netcentric--hlxsites.aem.live
main--infosys--hlxsites.aem.live
main--keysight--hlxsites.aem.live
main--ing--hlxsites.aem.live
main--caesars--hlxsites.aem.live
main--genesys--hlxsites.aem.live
main--bitdefender--hlxsites.aem.live
main--sas--hlxsites.aem.live
main--eaton--hlxsites.aem.live
main--commscope--hlxsites.aem.live
main--abbvie--hlxsites.aem.live
main--vodafone--hlxsites.aem.live
main--nttdata--hlxsites.aem.live
"

echo "================================"
echo "EDS Block Collector - Add Sites"
echo "================================"
echo ""

if [ -n "$1" ] && [ -f "$1" ]; then
    SITES=$(cat "$1")
    echo "Reading sites from: $1"
else
    SITES="$KNOWN_SITES"
    echo "Using built-in site list"
fi

ADDED=0
EXISTS=0
FAILED=0

for domain in $SITES; do
    # Skip empty lines and comments
    [[ -z "$domain" || "$domain" == \#* ]] && continue

    RESULT=$(curl -s -X POST "$API_BASE/sites" \
        -H "Content-Type: application/json" \
        -d "{\"domain\": \"$domain\"}" \
        --max-time 15 2>/dev/null)

    if echo "$RESULT" | grep -q '"success":true'; then
        echo "✓ Added: $domain"
        ((ADDED++))
    elif echo "$RESULT" | grep -q "already exists"; then
        echo "- Exists: $domain"
        ((EXISTS++))
    else
        echo "✗ Failed: $domain"
        ((FAILED++))
    fi
done

echo ""
echo "================================"
echo "Summary: $ADDED added, $EXISTS existing, $FAILED failed"
echo "================================"

# Show updated stats
echo ""
curl -s "$API_BASE/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"Total sites: {d['crawl']['sites_total']} ({d['crawl']['sites_pending']} pending)\")
"
