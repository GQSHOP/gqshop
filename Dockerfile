# ---- stage 1: storefront + templates build ----
FROM node:24-alpine AS shopbuild

WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/admin/package.json apps/admin/
COPY apps/user/package.json apps/user/
COPY packages/ packages/
# M5-β：模板包 package.json（目录可变，通配拷贝由 BuildKit 支持）
COPY templates/default/package.json templates/default/
COPY templates/minimal/package.json templates/minimal/
RUN pnpm install --frozen-lockfile=false

COPY tsconfig.base.json ./
COPY templates/ templates/
COPY apps/admin/ apps/admin/
COPY apps/user/ apps/user/
RUN pnpm --filter @gqshop/tpl-default --filter @gqshop/tpl-minimal --filter @gqshop/admin --filter @gqshop/user build

# ---- stage 2: core runtime ----
FROM node:24-alpine

WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/ packages/
COPY apps/core/package.json apps/core/
COPY templates/default/package.json templates/default/
COPY templates/minimal/package.json templates/minimal/
RUN pnpm install --frozen-lockfile=false

COPY tsconfig.base.json ./
COPY apps/core/ apps/core/
COPY --from=shopbuild /repo/templates /repo/templates
COPY --from=shopbuild /repo/apps/admin/dist /repo/apps/admin/dist
COPY --from=shopbuild /repo/apps/user/dist /repo/apps/user/dist

EXPOSE 8100

CMD ["pnpm", "--filter", "@gqshop/core", "start"]
