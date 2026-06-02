"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Layout,
  Button,
  Card,
  Form,
  Input,
  Modal,
App,
  Skeleton,
  Tooltip,
  ConfigProvider,
  theme
} from "antd";
import {
  ArrowLeftOutlined,
  SaveOutlined,
  PrinterOutlined,
} from "@ant-design/icons";
import { Edit3, QrCode, Package as PackageIcon } from "lucide-react";
import {
  useGetPackageByIdQuery,
  useUpdatePackageMutation,
} from "@/store/services/inventoryApi";
import { QRCodeSVG } from "qrcode.react";

const { Content } = Layout;

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "0.5rem",
        padding: "10px 0",
        borderBottom: "1px solid #f3f4f6",
      }}
    >
      <span
        style={{
          minWidth: 140,
          fontSize: "13px",
          color: "#9ca3af",
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: "14px", color: "#374151", fontWeight: 600, wordBreak: "break-word" }}>
        {value}
      </span>
    </div>
  );
}

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { notification } = App.useApp();
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const autoPrint = searchParams.get("action") === "print";

  const { data: pkg, isLoading, error } = useGetPackageByIdQuery(id);
  const [updatePackage, { isLoading: isUpdating }] = useUpdatePackageMutation();

  const qrPayload = JSON.stringify({ _id: id });

  // ── Edit Modal (owns its own form instance) ──────────────────────────
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");

  // Form lives here so it's only connected when the modal is in the tree
  const [editForm] = Form.useForm();

  const handleOpenEdit = () => {
    if (pkg) {
      editForm.setFieldsValue({ packageName: pkg.packageName });
      setPendingName(pkg.packageName);
    }
    setIsEditModalOpen(true);
  };

  const handleNameChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    setPendingName(e.target.value);
  };

  const handleConfirm = () => setIsConfirmOpen(true);

  const handleUpdate = async () => {
    if (!pendingName.trim()) {
      notification.warning({ title: "Chưa nhập tên", description: "Tên kiện hàng không được để trống.", placement: "topRight" });
      return;
    }
    try {
      await updatePackage({ id, packageName: pendingName.trim() }).unwrap();
      notification.success({ title: "Thành công", description: "Cập nhật kiện hàng thành công!", placement: "topRight" });
      editForm.setFieldsValue({ packageName: pendingName.trim() });
      setIsEditModalOpen(false);
      setIsConfirmOpen(false);
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        "Cập nhật kiện hàng thất bại!";
      notification.error({ title: "Thất bại", description: errMsg, placement: "topRight" });
      setIsConfirmOpen(false);
    }
  };

  // ── Print Modal ─────────────────────────────────────────────────────
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const autoPrintOpenedRef = useRef(false);
  useEffect(() => {
    if (autoPrint && pkg && !autoPrintOpenedRef.current) {
      autoPrintOpenedRef.current = true;
      setIsPrintModalOpen(true);
    }
  }, [autoPrint, pkg]);

  const handlePrint = () => setIsPrintModalOpen(true);

  const executePrint = () => {
    const printContent = printRef.current;
    if (!printContent) return;

    const win = window.open("", "_blank", "width=420,height=560");
    if (!win) {
      notification.error({ title: "Không thể in", description: "Không thể mở cửa sổ in. Vui lòng kiểm tra popup blocker.", placement: "topRight" });
      return;
    }

    win.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>In mã QR - ${pkg?.packageName ?? id}</title>
          <style>
            @page { size: B5 portrait; margin: 0; }
            * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { font-family: 'Segoe UI', Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; background: #fff; }
            .label { text-align: center; margin-bottom: 1.2rem; }
            .label h2 { font-size: 1rem; font-weight: 700; color: #111827; margin-bottom: 0.2rem; }
            .qr-container { border: 2px solid #d1d5db; border-radius: 10px; padding: 1.2rem; display: flex; align-items: center; justify-content: center; background: #fff; }
            @media print { body { padding: 0.8rem; } .no-print { display: none !important; } .qr-container { border: 2px solid #000; } }
          </style>
        </head>
        <body>
          <div class="label"><h2>${pkg?.packageName ?? ""}</h2></div>
          <div class="qr-container">${printContent.innerHTML}</div>
          <br />
          <div class="no-print" style="display:flex;flex-direction:column;align-items:center;gap:0.5rem">
            <button onclick="window.print()" style="padding:9px 22px;font-size:13px;border-radius:7px;border:1px solid #d1d5db;background:#f9fafb;cursor:pointer">In mã QR</button>
            <button onclick="window.close()" style="padding:9px 22px;font-size:13px;border-radius:7px;border:none;background:#2563eb;color:#fff;cursor:pointer">Đóng</button>
          </div>
        </body>
      </html>
    `);
    win.document.close();
  };

  return (
    <ConfigProvider
  theme={{
    algorithm: theme.darkAlgorithm,
    token: {
      // Màu nền chính cho các khối (Card, Input, v.v.)
      colorBgContainer: 'var(--bg-raised)',
      // Màu nền cho các thành phần nổi (Modal, Popconfirm, Tooltip)
      colorBgElevated: 'var(--bg-surface)',
      // Màu nền tổng thể của Layout
      colorBgLayout: 'var(--bg-surface)',
      // Màu chữ chính và tiêu đề (Fix vụ title bị tối)
      colorText: 'var(--text-primary)',
      colorTextHeading: 'var(--text-primary)',
      colorTextDescription: 'var(--text-secondary)',
      // Màu border đồng bộ
      colorBorder: 'var(--border-mid)',
      // Font chữ JetBrains Mono
      fontFamily: 'var(--font-jetbrains)',
      // Màu nhấn (Primary) - lấy theo biến accent của ông
      colorPrimary: 'var(--accent)',
    },
    components: {
      Modal: {
        headerBg: 'var(--bg-surface)',
        contentBg: 'var(--bg-surface)',
        footerBg: 'var(--bg-surface)',
      },
      Card: {
        // Đảm bảo Card luôn dùng nền raised
        colorBgContainer: 'var(--bg-raised)',
      },
      Notification: {
        colorBgElevated: 'var(--bg-surface)',
        colorTextHeading: 'var(--text-primary)',
      }
    },
  }}
    >
      <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <Content
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: 640, width: "100%" }}>
          {/* Back */}
          <Button
            type="link"
            icon={<ArrowLeftOutlined />}
            onClick={() => router.back()}
            style={{ marginBottom: "1rem", paddingLeft: 0, fontSize: "15px", color: "#6b7280" }}
          >
            Quay lại danh sách
          </Button>

          <Card
            variant="borderless"
            style={{ borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}
          >
            {isLoading && <Skeleton active paragraph={{ rows: 8 }} />}

            {error && (
              <div style={{ textAlign: "center", padding: "2rem" }}>
                <p style={{ color: "#ef4444" }}>Không tìm thấy kiện hàng này.</p>
              </div>
            )}

            {!isLoading && !error && pkg && (
              <>
                {/* Header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "1rem",
                    marginBottom: "1.5rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", minWidth: 0 }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 14,
                        background: "#eff6ff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <PackageIcon size={28} style={{ color: "#2563eb" }} />
                    </div>
                    <h2
                      style={{
                        margin: 0,
                        fontWeight: 800,
                        fontSize: "1.4rem",
                        lineHeight: 1.3,
                        color: "#111827",
                      }}
                    >
                      {pkg.packageName}
                    </h2>
                  </div>

                  <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                    <Button icon={<Edit3 size={14} />} onClick={handleOpenEdit} style={{ borderRadius: 8 }}>
                      Sửa tên
                    </Button>
                    <Button
                      type="primary"
                      icon={<QrCode size={14} />}
                      onClick={handlePrint}
                      style={{ background: "#2563eb", borderRadius: 8, display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      In mã QR
                    </Button>
                  </div>
                </div>

                <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: "0.5rem" }}>
                  <InfoRow
                    label="Tên kiện hàng:"
                    value={<span style={{ fontWeight: 700 }}>{pkg.packageName}</span>}
                  />
                  {pkg.createdAt && (
                    <InfoRow
                      label="Ngày tạo:"
                      value={new Date(pkg.createdAt).toLocaleDateString("vi-VN", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    />
                  )}
                  {pkg.updatedAt && (
                    <InfoRow
                      label="Ngày cập nhật:"
                      value={new Date(pkg.updatedAt).toLocaleDateString("vi-VN", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    />
                  )}
                </div>

                {/* QR Preview */}
                <Card
                  style={{
                    background: "#fafafa",
                    border: "1px dashed #d1d5db",
                    borderRadius: 12,
                    marginTop: "1.5rem",
                  }}
                  styles={{ body: { padding: "1.25rem", textAlign: "center" } }}
                >
                  <p
                    style={{
                      fontSize: "12px",
                      color: "#9ca3af",
                      marginBottom: "0.75rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Mã QR — dữ liệu bên trong
                  </p>
                  <code
                    style={{
                      display: "block",
                      background: "#1f2937",
                      color: "#10b981",
                      padding: "8px 14px",
                      borderRadius: 8,
                      fontSize: "12px",
                      fontFamily: "monospace",
                      wordBreak: "break-all",
                      marginBottom: "0.75rem",
                    }}
                  >
                    {qrPayload}
                  </code>
                  <Tooltip title="Quét mã QR này bằng thiết bị cầm tay để nhận diện kiện hàng">
                    <p style={{ fontSize: "12px", color: "#9ca3af", margin: 0 }}>
                      Quét mã QR này để nhận diện kiện hàng
                    </p>
                  </Tooltip>
                </Card>
              </>
            )}
          </Card>
        </div>
      </Content>

      {/* Edit Modal — form instance lives here, only connected when open */}
      {isEditModalOpen && (
        <Modal
          title={
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
              <Edit3 size={18} style={{ color: "#2563eb" }} />
              Sửa kiện hàng
            </div>
          }
          open
          onCancel={() => {
            setIsEditModalOpen(false);
            setIsConfirmOpen(false);
          }}
          footer={null}
          centered
        >
          <Form
            form={editForm}
            layout="vertical"
            style={{ marginTop: "1rem" }}
          >
            <Form.Item
              name="packageName"
              label="Tên kiện hàng"
              rules={[{ required: true, message: "Tên kiện hàng không được để trống" }]}
            >
              <Input
                placeholder="Nhập tên kiện hàng mới..."
                size="large"
                style={{ borderRadius: 10 }}
                onChange={handleNameChange}
              />
            </Form.Item>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <Button
                size="large"
                onClick={() => { setIsEditModalOpen(false); setIsConfirmOpen(false); }}
                style={{ borderRadius: 10 }}
              >
                Hủy
              </Button>
              <Button
                type="primary"
                size="large"
                onClick={handleConfirm}
                style={{ background: "#2563eb", borderRadius: 10, fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}
              >
                <SaveOutlined /> Lưu thay đổi
              </Button>
            </div>
          </Form>
        </Modal>
      )}

      {/* Confirm Modal */}
      <Modal
        title={<span style={{ fontWeight: 700, color: "#1f2937" }}>Xác nhận cập nhật kiện hàng?</span>}
        open={isConfirmOpen}
        onCancel={() => setIsConfirmOpen(false)}
        centered
        footer={
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
            <Button size="large" onClick={() => setIsConfirmOpen(false)} style={{ borderRadius: 10 }}>
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              loading={isUpdating}
              onClick={handleUpdate}
              style={{ background: "#2563eb", borderRadius: 10, fontWeight: 600 }}
            >
              Xác nhận cập nhật
            </Button>
          </div>
        }
      >
        <p style={{ color: "#4b5563", lineHeight: 1.7 }}>Bạn có chắc chắn muốn cập nhật kiện hàng này?</p>
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem 1rem",
            background: "#f9fafb",
            borderRadius: 10,
            border: "1px solid #e5e7eb",
          }}
        >
          <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "4px" }}>Tên kiện hàng mới:</p>
          <strong style={{ color: "#2563eb" }}>{pendingName}</strong>
        </div>
      </Modal>

      {/* Print Modal */}
      <Modal
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
            <PrinterOutlined style={{ color: "#2563eb" }} />
            In mã QR
          </div>
        }
        open={isPrintModalOpen}
        onCancel={() => setIsPrintModalOpen(false)}
        centered
        width={400}
        footer={
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
            <Button size="large" onClick={() => setIsPrintModalOpen(false)} style={{ borderRadius: 10 }}>
              Đóng
            </Button>
            <Button
              type="primary"
              size="large"
              icon={<PrinterOutlined />}
              onClick={executePrint}
              style={{ background: "#2563eb", borderRadius: 10, fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}
            >
              In QR Code
            </Button>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0.5rem 0" }}>
          {/* Hidden QR for print export */}
          <div ref={printRef} style={{ display: "none" }}>
            <QRCodeSVG value={qrPayload} size={200} level="M" includeMargin />
          </div>

          {/* Visible preview */}
          <div
            style={{
              border: "2px dashed #d1d5db",
              borderRadius: 16,
              padding: "1.25rem",
              background: "#fff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <p
              style={{
                fontSize: "13px",
                color: "#6b7280",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {pkg?.packageName}
            </p>
            <QRCodeSVG value={qrPayload} size={200} level="M" includeMargin bgColor="#ffffff" fgColor="#1f2937" />
            <p
              style={{
                fontSize: "11px",
                color: "#9ca3af",
                fontFamily: "monospace",
                wordBreak: "break-all",
                textAlign: "center",
                maxWidth: 200,
              }}
            >
              {qrPayload}
            </p>
          </div>

          <p style={{ fontSize: "12px", color: "#9ca3af", textAlign: "center", marginTop: "0.75rem" }}>
            Mã QR chứa <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 4 }}>{"{ \"_id\": \"...\" }"}</code>{" "}
            — dán vào scanner trên robot để nhận diện kiện hàng.
          </p>
        </div>
      </Modal>
    </Layout>
    </ConfigProvider>
  );
}
