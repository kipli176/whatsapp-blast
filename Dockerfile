# Dockerfile
FROM node:20-alpine

# Install git (needed by some npm packages)
RUN apk add --no-cache git

WORKDIR /app

# Initialize npm project and install dependencies
RUN npm init -y \
  && npm install @whiskeysockets/baileys@6.7.18 qrcode-terminal@0.12.0 express

COPY index.mjs .
COPY public public
CMD ["node", "index.mjs"]
