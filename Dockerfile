FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

# Install language-specific build/runtime deps only when routes/services require them.
RUN set -eux; \
		eval "$(node src/deployment/scripts/runtime-install-plan.mjs)"; \
		if [ "$NEED_GO" = "1" ]; then \
			apk add --no-cache go; \
		fi; \
		if [ "$NEED_RUST" = "1" ]; then \
			apk add --no-cache rust cargo; \
		fi; \
		if [ "$NEED_PYTHON" = "1" ]; then \
			apk add --no-cache python3 py3-pip; \
			for framework in $PYTHON_FRAMEWORKS; do \
				case "$framework" in \
					flask) pip3 install --break-system-packages flask ;; \
					falcon) pip3 install --break-system-packages falcon ;; \
					bottle) pip3 install --break-system-packages bottle ;; \
				esac; \
			done; \
		fi

RUN npm run build

FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Render web services commonly use 10000 on free plan.
ENV PORT=10000
EXPOSE 10000

CMD ["nginx", "-g", "daemon off;"]