'use client';

import { Button, Typography, Layout } from 'antd';
import Link from 'next/link';

const { Title, Paragraph } = Typography;
const { Content } = Layout;

export default function HomePage() {
  return (
    <Layout style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <Content style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ background: '#fff', padding: '3rem', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', textAlign: 'center', maxWidth: 500, width: '100%' }}>
          <Typography>
            <Title level={2}>Welcome to Our Dog Breeds</Title>
            <Paragraph style={{ fontSize: '16px', color: '#666', marginBottom: '2rem' }}>
              Browse our latest breeds with RTK Query and Ant Design integration.
            </Paragraph>
          </Typography>
          <Link href="/products">
            <Button type="primary" size="large">
              View Breeds
            </Button>
          </Link>
        </div>
      </Content>
    </Layout>
  );
}
