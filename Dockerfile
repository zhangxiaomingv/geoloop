# GEOloopOS Identity Engine · AI可见度操作系统 — 私有化部署镜像
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# 先装依赖，利用构建缓存
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# 拷贝代码（config.ts 在项目根，被 src/* 以 ../config.js 引用）
COPY config.ts ./
COPY tsconfig.json ./
COPY src ./src

# 数据目录 —— 挂载 volume 持久化（检测历史/锚点/引用追踪/域名追踪）
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8788
CMD ["npx", "tsx", "src/server.ts"]
