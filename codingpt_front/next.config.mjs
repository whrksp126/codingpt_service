/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 출력 standalone — Docker 이미지 경량화
  output: 'standalone',
};

export default nextConfig;
