FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache curl

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy backend code, schema, dashboard, and configs
COPY src/backend ./src/backend
COPY src/TaxiWisam.Api/wwwroot/dashboard ./src/TaxiWisam.Api/wwwroot/dashboard
COPY scripts ./scripts
COPY data ./data

# Expose backend HTTP port
EXPOSE 5050

# Environment defaults
ENV PORT=5050
ENV NODE_ENV=production
ENV DATA_FILE=/app/data/state.json
ENV UPLOADS_DIR=/app/data/uploads

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5050/api/admin/stats || exit 1

CMD ["node", "src/backend/server.js"]
