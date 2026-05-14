"use client";

import Link from "next/link";
import { useGetProductsQuery } from "../../store/services/productApi";
import { Card, Typography, Alert, Row, Col, Layout, Button, Skeleton } from "antd";

const { Title, Paragraph, Text } = Typography;
const { Content } = Layout;

export default function ProductsPage() {
  const { data: products, isLoading, error } = useGetProductsQuery();

  return (
    <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <Content style={{ padding: "2rem", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <Title level={2} style={{ margin: 0 }}>Dog Breeds</Title>
          <Link href="/">
            <Button type="link" style={{ fontSize: '16px' }}>&larr; Back to Home</Button>
          </Link>
        </div>

        {isLoading && (
          <Row gutter={[24, 24]}>
            {[...Array(8)].map((_, i) => (
              <Col xs={24} sm={12} md={8} lg={6} key={i}>
                <Card style={{ width: "100%", borderRadius: 12 }}>
                  <Skeleton active paragraph={{ rows: 3 }} />
                </Card>
              </Col>
            ))}
          </Row>
        )}

        {error && (
          <Alert
            message="Oops! Something went wrong."
            description="Failed to load breeds. Please try again later."
            type="error"
            showIcon
            style={{ marginBottom: "1.5rem", borderRadius: 8 }}
          />
        )}

        {!isLoading && !error && products && (
          <Row gutter={[24, 24]}>
            {products.map((breed) => (
              <Col xs={24} sm={12} md={8} lg={6} key={breed.id}>
                <Link href={`/products/${breed.id}`}>
                  <Card 
                    hoverable 
                    style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 12 }}
                    styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column' } }}
                  >
                    <Title level={4} style={{ marginBottom: 8 }}>{breed.attributes.name}</Title>
                    <Text type="secondary" strong style={{ display: 'block', marginBottom: 12 }}>
                      Life: {breed.attributes.life.min} - {breed.attributes.life.max} years
                    </Text>
                    <Paragraph ellipsis={{ rows: 3 }} style={{ flex: 1, margin: 0, color: '#666' }}>
                      {breed.attributes.description}
                    </Paragraph>
                  </Card>
                </Link>
              </Col>
            ))}
          </Row>
        )}
      </Content>
    </Layout>
  );
}
