# Docker image for the iPhone price matrix crawler.
# Reproducible Node 20 + Playwright + Chromium environment.
# Build:  docker build -t iphone-price-matrix .
# Run:    docker run --rm -it --mount type=bind,source=./data,target=/app/data \
#                       --mount type=bind,source=./config,target=/app/config \
#                       iphone-price-matrix --help
#
# IMPORTANT — headed vs headless:
#   The crawler defaults to a real Chrome window (headed) because Back Market
#   blocks headless browsers (HTTP 403). A Docker container has no display by
#   default, so headed Chrome inside the container will not render to your
#   desktop. You have two options:
#
#   1. Run headless inside Docker (if your target site allows it):
#      docker run --rm -it --mount ... iphone-price-matrix crawl --model iphone-15 --headless
#
#      Back Market currently returns 403 to headless. Other sites in this
#      project (Amazon, Refurbed, musicMagpie) may behave differently — test
#      each one.
#
#   2. Run headed with a display (Xvfb / VNC) inside the container, or just
#      run the same npm commands directly on your host (no container) when you
#      need a real Chrome window. The Docker image is primarily for environment
#      reproducibility, not for avoiding the display requirement.
#
# Chrome profile:
#   The crawler reuses data/.chrome-profile to build trust with Back Market.
#   Mount your existing data/ folder (which contains .chrome-profile) so the
#   profile persists across container runs. Without the profile, Back Market
#   may show bot-check interstitials on first run.
#
# The image does NOT bake in data/ or config/ — these are mounted at runtime
# because they're user-specific (scraped data, Chrome profile, model config).

FROM node:20-slim

WORKDIR /app

# Playwright's Chromium needs these at runtime. playwright install --with-deps
# would add them, but being explicit here keeps the layer readable and lets us
# pin the exact set. This list covers Chromium + NSS for HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    libglib2.0-0 libgtk-3-0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install deps and Playwright's Chromium in one shot.
# --with-deps would also install system libraries, but we already did above.
COPY package.json package-lock.json ./
RUN npm install && npx playwright install chromium

# Source code and config (config is small and public — product URLs).
COPY . .

# Make npm scripts available as the default entrypoint behavior.
# Running `docker run iphone-price-matrix` prints help.
# Running `docker run iphone-price-matrix crawl --model iphone-15` runs a crawl.
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
CMD ["--help"]