FROM louislam/dockge:base@sha256:cb8e8596cd668ee727f9507325f2f2e8d2069160305d75103cf41656b5c042cb AS release
WORKDIR /app
COPY --chown=node:node  . .
RUN npm ci --production
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sh", "./scripts/start-demo-kuma.sh"]
