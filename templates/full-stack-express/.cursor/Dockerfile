FROM node:24.22.1-bookworm

# Enable Corepack while building the image, as root. The cloud install
# script must not call `corepack enable`: that writes shims into the Node
# prefix and fails when the build user cannot write there.
RUN corepack enable
