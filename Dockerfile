# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Production stage
FROM node:20-alpine

WORKDIR /app

# Set timezone to Asia/Colombo (Sri Lanka)
ENV TZ=Asia/Colombo
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Colombo /etc/localtime && \
    echo "Asia/Colombo" > /etc/timezone

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Create data directory for persistent storage
RUN mkdir -p data public/uploads && \
    chown -R nodejs:nodejs data public/uploads

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start the application
CMD ["node", "src/server.js"]