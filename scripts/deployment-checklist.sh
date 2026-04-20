#!/bin/bash

# ============================================================================
# RENDER DEPLOYMENT PRE-FLIGHT CHECKLIST
# ============================================================================
# Run this script before deploying to Render to verify all components are ready
# Usage: bash scripts/deployment-checklist.sh

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Helper functions
pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASSED++))
}

fail() {
    echo -e "${RED}✗${NC} $1"
    ((FAILED++))
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARNINGS++))
}

skip() {
    echo -e "${YELLOW}-${NC} $1"
}

echo -e "${BOLD}Babylon Game Starter - Render Deployment Pre-Flight ${NC}\n"

# ============================================================================
# 1. LOCAL ENVIRONMENT
# ============================================================================
echo -e "${BOLD}1. Local Environment${NC}"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    pass "Node.js installed: $NODE_VERSION"
else
    fail "Node.js not found (required)"
fi

if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    pass "npm installed: $NPM_VERSION"
else
    fail "npm not found (required)"
fi

if command -v git &> /dev/null; then
    pass "Git installed"
else
    fail "Git not found (required)"
fi

if command -v go &> /dev/null; then
    GO_VERSION=$(go version | awk '{print $3}')
    pass "Go installed: $GO_VERSION"
else
    warn "Go not found locally (will be installed in Docker)"
fi

if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}')
    pass "Docker installed: $DOCKER_VERSION"
else
    warn "Docker not found (needed for local build verification)"
fi

echo ""

# ============================================================================
# 2. PROJECT STRUCTURE
# ============================================================================
echo -e "${BOLD}2. Project Structure${NC}"

# Client files
test -f "src/client/config/game_config.ts" && pass "Game config exists" || fail "Game config missing"
test -f "src/client/types/multiplayer.ts" && pass "Multiplayer types exist" || fail "Multiplayer types missing"
test -f "src/client/managers/multiplayer_manager.ts" && pass "Multiplayer manager exists" || fail "Multiplayer manager missing"
test -f "src/client/datastar/datastar_client.ts" && pass "Datastar client exists" || fail "Datastar client missing"
test -d "src/client/sync" && pass "Sync modules directory exists" || fail "Sync modules missing"

# Server files
test -f "src/server/multiplayer/main.go" && pass "Go main.go exists" || fail "Go main.go missing"
test -f "src/server/multiplayer/handlers.go" && pass "Go handlers.go exists" || fail "Go handlers.go missing"
test -f "src/server/multiplayer/utils.go" && pass "Go utils.go exists" || fail "Go utils.go missing"
test -f "src/server/multiplayer/go.mod" && pass "Go module file exists" || fail "Go module file missing"

# Deployment files
test -f "Dockerfile" && pass "Dockerfile exists" || fail "Dockerfile missing"
test -f "nginx.conf" && pass "nginx.conf exists" || fail "nginx.conf missing"
test -f "render.yaml" && pass "render.yaml exists" || fail "render.yaml missing"
test -f "src/deployment/settings/settings.mjs" && pass "Deployment settings exist" || fail "Deployment settings missing"

echo ""

# ============================================================================
# 3. DEPLOYMENT CONFIGURATION
# ============================================================================
echo -e "${BOLD}3. Deployment Configuration${NC}"

# Check settings.mjs for multiplayer service
if grep -q "multiplayer" "src/deployment/settings/settings.mjs"; then
    pass "Multiplayer service registered in settings"
else
    fail "Multiplayer service NOT registered in settings"
fi

if grep -q "type: 'go'" "src/deployment/settings/settings.mjs"; then
    pass "Go runtime declared in settings"
else
    fail "Go runtime NOT declared in settings"
fi

if grep -q "routePrefix: '/api/multiplayer'" "src/deployment/settings/settings.mjs"; then
    pass "Multiplayer route prefix configured"
else
    fail "Multiplayer route prefix NOT configured"
fi

# Check nginx.conf for API proxying
if grep -q "location /api/multiplayer/" "nginx.conf"; then
    pass "Nginx multiplayer proxy configured"
else
    fail "Nginx multiplayer proxy NOT configured"
fi

if grep -q "proxy_pass http://localhost:5000" "nginx.conf"; then
    pass "Nginx proxies to port 5000"
else
    fail "Nginx NOT proxying to port 5000"
fi

if grep -q "proxy_set_header Upgrade" "nginx.conf"; then
    pass "Nginx SSE support configured"
else
    warn "Nginx SSE headers not found"
fi

echo ""

# ============================================================================
# 4. CLIENT MULTIPLAYER CONFIG
# ============================================================================
echo -e "${BOLD}4. Client Multiplayer Configuration${NC}"

if grep -q "MULTIPLAYER:" "src/client/config/game_config.ts"; then
    pass "Multiplayer config section exists"
else
    fail "Multiplayer config section missing"
fi

if grep -q "ENABLED: true" "src/client/config/game_config.ts"; then
    pass "Multiplayer enabled by default"
else
    warn "Multiplayer may be disabled by default"
fi

if grep -q "PRODUCTION_SERVER: 'bgs-mp.onrender.com'" "src/client/config/game_config.ts"; then
    pass "Production server configured"
else
    warn "Production server not configured (edit settings after deployment)"
fi

if grep -q "LOCAL_SERVER: 'localhost:5000'" "src/client/config/game_config.ts"; then
    pass "Local development server configured"
else
    warn "Local development server not configured"
fi

echo ""

# ============================================================================
# 5. BUILD VERIFICATION
# ============================================================================
echo -e "${BOLD}5. Build Verification${NC}"

echo "Checking npm dependencies..."
if npm ls @babylonjs/core &> /dev/null; then
    pass "Babylon.js core dependencies installed"
else
    fail "Babylon.js dependencies not installed"
fi

if test -f "package.json"; then
    pass "package.json exists"
else
    fail "package.json missing"
fi

echo ""
echo "Testing build..."
if npm run build &> /dev/null; then
    pass "Client builds successfully"
    if test -f "dist/index.html"; then
        pass "dist/index.html generated"
    else
        fail "dist/index.html not generated"
    fi
else
    fail "Client build failed"
fi

echo ""

# ============================================================================
# 6. GO COMPILATION TEST
# ============================================================================
echo -e "${BOLD}6. Go Compilation Test${NC}"

if command -v go &> /dev/null; then
    echo "Attempting to compile Go server..."
    cd src/server/multiplayer
    
    if go mod tidy &> /dev/null; then
        pass "Go modules tidy successful"
    else
        warn "Go mod tidy had issues"
    fi
    
    if go build -o /tmp/multiplayer-test . &> /dev/null; then
        pass "Go server compiles successfully"
        rm -f /tmp/multiplayer-test
    else
        fail "Go server compilation failed"
    fi
    
    cd ../../..
else
    skip "Go compiler not available locally (will compile in Docker)"
fi

echo ""

# ============================================================================
# 7. GIT STATUS
# ============================================================================
echo -e "${BOLD}7. Git Status${NC}"

if git rev-parse --git-dir > /dev/null 2>&1; then
    pass "Git repository detected"
    
    if ! git diff-index --quiet HEAD --; then
        warn "Uncommitted changes detected:"
        git diff-index --name-only HEAD | sed 's/^/  - /'
    else
        pass "All changes committed"
    fi
    
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    pass "Current branch: $BRANCH"
else
    fail "Not a git repository"
fi

echo ""

# ============================================================================
# 8. DOCKER BUILD TEST (Optional)
# ============================================================================
echo -e "${BOLD}8. Docker Build Test (Optional)${NC}"

if command -v docker &> /dev/null; then
    read -p "Run Docker build simulation? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Building Docker image..."
        if docker build -t babylon-mp-test:latest . &> /tmp/docker-build.log; then
            DOCKER_SIZE=$(docker images babylon-mp-test:latest --format "{{.Size}}")
            pass "Docker image builds successfully (size: $DOCKER_SIZE)"
            
            # Clean up test image
            docker rmi babylon-mp-test:latest &> /dev/null
        else
            fail "Docker build failed (check /tmp/docker-build.log)"
        fi
    fi
else
    skip "Docker not available (install to test Docker build)"
fi

echo ""

# ============================================================================
# 9. CHECKLIST SUMMARY
# ============================================================================
echo -e "${BOLD}═════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}Summary:${NC}"
echo -e "${GREEN}Passed${NC}:    $PASSED"
echo -e "${RED}Failed${NC}:    $FAILED"
echo -e "${YELLOW}Warnings${NC}:  $WARNINGS"
echo -e "${BOLD}═════════════════════════════════════════════════════════${NC}"

echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✓ ALL CHECKS PASSED${NC}"
    echo ""
    echo "You're ready to deploy to Render!"
    echo ""
    echo "Next steps:"
    echo "  1. git commit -am 'Ready for Render deployment'"
    echo "  2. git push origin $(git rev-parse --abbrev-ref HEAD)"
    echo "  3. Connect via Render dashboard and deploy"
    echo ""
    exit 0
else
    echo -e "${RED}${BOLD}✗ DEPLOYMENT NOT READY${NC}"
    echo ""
    echo "Please fix the failures above before deploying."
    echo ""
    exit 1
fi
