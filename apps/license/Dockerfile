# GQSHOP 市场站服务（apps/license，独立镜像——不依赖 workspace 其他包）
# 构建上下文 = 仓库根（compose: context ./src + 本 Dockerfile 路径）
FROM node:24-alpine

WORKDIR /srv
COPY apps/license/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY apps/license/src ./src

ENV GQSHOP_LICENSE_PORT=8102
EXPOSE 8102
CMD ["node", "src/main.ts"]
