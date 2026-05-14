"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useGetProductByIdQuery } from "../../../store/services/productApi";
import { Layout, Typography, Button, Descriptions, Alert, Skeleton, Card, Space, Tag } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

const { Title, Paragraph, Text } = Typography;
const { Content } = Layout;

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const { id } = use(params);

  const { data: breed, isLoading, error } = useGetProductByIdQuery(id);

  return (
    <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: "2rem" }}>
        <div style={{ maxWidth: 800, width: "100%" }}>
          <Button 
            type="link" 
            icon={<ArrowLeftOutlined />} 
            onClick={() => router.back()}
            style={{ marginBottom: "1rem", paddingLeft: 0, fontSize: '16px' }}
          >
            Back
          </Button>

          <Card variant="borderless" style={{ borderRadius: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}>
            {isLoading && <Skeleton active paragraph={{ rows: 8 }} />}

            {error && (
              <Alert
                message="Error!"
                description="Failed to load breed details."
                type="error"
                showIcon
              />
            )}

            {!isLoading && !error && breed && (
              <Space orientation="vertical" size="large" style={{ width: '100%' }}>
                <div>
                  <Title level={2} style={{ marginTop: 0, marginBottom: 8 }}>
                    {breed.attributes.name}
                  </Title>
                  <Tag color="blue" style={{ fontSize: '14px', padding: '4px 12px' }}>
                    Life Expectancy: {breed.attributes.life.min} - {breed.attributes.life.max} years
                  </Tag>
                </div>

                <Descriptions title="Breed Details" bordered column={{ xs: 1, sm: 1, md: 2 }}>
                  <Descriptions.Item label="Hypoallergenic">
                    {breed.attributes.hypoallergenic ? <Text type="success" strong>Yes</Text> : <Text type="danger" strong>No</Text>}
                  </Descriptions.Item>
                  <Descriptions.Item label="Weight (Male)">
                    {breed.attributes.male_weight.min} - {breed.attributes.male_weight.max} kg
                  </Descriptions.Item>
                  <Descriptions.Item label="Weight (Female)">
                    {breed.attributes.female_weight.min} - {breed.attributes.female_weight.max} kg
                  </Descriptions.Item>
                </Descriptions>

                <div>
                  <Title level={4}>Description</Title>
                  <Paragraph style={{ fontSize: '16px', lineHeight: 1.6, color: '#444' }}>
                    {breed.attributes.description}
                  </Paragraph>
                </div>
              </Space>
            )}
          </Card>
        </div>
      </Content>
    </Layout>
  );
}
