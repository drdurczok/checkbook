# Debian-based image: tsc segfaults on alpine/musl due to its small default thread stack.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci

COPY . /app
ARG VITE_ENABLE_DEV_AUTH
ENV VITE_ENABLE_DEV_AUTH=${VITE_ENABLE_DEV_AUTH}
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
