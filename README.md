# Apple Taiwan Mac Spec & Price-Performance Dashboard

A fully-automated, live-validated crawler and dashboard for comparing specifications, prices, and price-to-RAM value ratios of Apple Mac products in Taiwan.

## Features

- **Live Validation Pipeline**: Automatically generates custom configure-to-order (BTO/CTO) URLs and sends request to Apple servers. Only valid configurations (returning HTTP 200 OK) are included, and invalid configurations (redirecting via HTTP 301/302) are dynamically excluded.
- **Smart Spec Upgrades**: Handles complex BTO dependency rules (e.g., upgrading M5 Max from 36GB to 64GB/128GB RAM or M4 Max from 36GB to 64GB RAM automatically upgrades GPU and CPU core counts in the constructed BTO URLs).
- **Color Merge & Deduplication**: Groups identical configurations across colors, simplifying choices and cleanly showcasing all available color variants in a single entry.
- **Dynamic Live Shipping Data**: Pulls actual local availability and shipping windows via the Apple Availability SBA API and calculates readable shipping ranges.
- **Premium Compact Dashboard**: Displays configuration spec tables in a high-density, professional layout with point-and-click row direct links to pre-selected configurations on the official Apple online store.

## Getting Started

### Prerequisites

- Node.js (v16+)

### Installation & Run

1. Clone the repository to your local directory.
2. Run the crawler to scrape specifications, fetch live pricing/shipping, perform live BTO URL verification, and compile the static dashboard:
   ```bash
   node crawler.js
   ```
3. Open `index.html` in your web browser to view the premium dashboard.

## File Structure

- `crawler.js`: Scraper and live BTO verification script.
- `index_template.html`: Layout template with styling for the responsive high-density dashboard.
- `index.html`: Compiled static dashboard with embedded JSON data.
- `mac_configs.json`: Fully verified crawled data.
