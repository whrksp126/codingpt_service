/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 출력 standalone — Docker 이미지 경량화
  output: 'standalone',
  // BYO 전환 이전의 웹 대시보드는 더 이상 공개하지 않는다.
  async redirects() {
    return [
      { source: '/plans', destination: '/#pricing', permanent: false },
      { source: '/me', destination: '/', permanent: false },
      { source: '/billing/:path*', destination: '/', permanent: false },
      { source: '/workspace/:path*', destination: '/', permanent: false },
      { source: '/chat', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
