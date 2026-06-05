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
  Tag,
  theme,
} from "antd";
import {
  ArrowLeftOutlined,
  SaveOutlined,
  PrinterOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { Edit3, QrCode, Package as PackageIcon } from "lucide-react";
import {
  useGetPackageByIdQuery,
  usePatchPackageStatusMutation,
  useUpdatePackageMutation,
} from "@/store/services/inventoryApi";
import { QRCodeSVG } from "qrcode.react";

import AprilTag from "@/components/AprilTag";
import { aprilTagToSvgString } from "@/lib/aprilTag";
import type { PackageStatus } from "@/types/inventory";

const { Content } = Layout;

const LABEL_SIZE = 300;
const APRIL_TAG_SIZE = 200;
const QR_SIZE = 100;

const STATUS_PALETTE: Record<PackageStatus, { bg: string; border: string; text: string; label: string }> = {
  CREATED: { bg: "rgba(0,212,255,0.10)", border: "rgba(0,212,255,0.30)", text: "var(--accent)", label: "Đã tạo" },
  IN_PROGRESS: { bg: "rgba(255,184,0,0.10)", border: "rgba(255,184,0,0.30)", text: "var(--warning)", label: "Đang xử lý" },
  FINISHED: { bg: "rgba(0,255,170,0.08)", border: "rgba(0,255,170,0.25)", text: "var(--success)", label: "Hoàn thành" },
};

function StatusTag({ status }: { status: PackageStatus }) {
  const c = STATUS_PALETTE[status] ?? STATUS_PALETTE.CREATED;
  return (
    <Tag
      style={{
        borderRadius: "8px",
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700,
        fontSize: "12px",
        padding: "2px 10px",
      }}
    >
      {c.label}
    </Tag>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "0.5rem",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-dim)",
      }}
    >
      <span
        style={{
          minWidth: 140,
          fontSize: "13px",
          color: "var(--text-muted)",
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: 600, wordBreak: "break-word" }}>
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
  const [patchStatus, { isLoading: isPatching }] = usePatchPackageStatusMutation();

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

  // ── Finish Modal ──────────────────────────────────────────────────
  const [isFinishConfirmOpen, setIsFinishConfirmOpen] = useState(false);
  const handleFinishClick = () => setIsFinishConfirmOpen(true);
  const handleConfirmFinish = async () => {
    try {
      await patchStatus({ id, status: "FINISHED" }).unwrap();
      notification.success({
        title: "Đã hoàn thành",
        description: "Mã AprilTag đã được giải phóng về pool.",
        placement: "topRight",
      });
      setIsFinishConfirmOpen(false);
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        "Không thể cập nhật trạng thái.";
      notification.error({ title: "Thất bại", description: errMsg, placement: "topRight" });
    }
  };

  // ── Print Modal ─────────────────────────────────────────────────────
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);

  const autoPrintOpenedRef = useRef(false);
  useEffect(() => {
    if (autoPrint && pkg && !autoPrintOpenedRef.current) {
      autoPrintOpenedRef.current = true;
      setIsPrintModalOpen(true);
    }
  }, [autoPrint, pkg]);

  const handlePrint = () => setIsPrintModalOpen(true);

  const executePrint = () => {
    if (!pkg) return;

    const safeName = (pkg.packageName ?? "").replace(/[<>"]/g, (c: string) =>
      ({ "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    );
    const tagId = pkg.tagId;
    const hasTag = typeof tagId === "number";
    const statusLabel = STATUS_PALETTE[pkg.status]?.label ?? pkg.status;
    const hiddenQr = document.querySelector("[data-print-qr]")?.innerHTML ?? "";
    const aprilTagMarkup = hasTag
      ? aprilTagToSvgString(tagId as number, APRIL_TAG_SIZE)
      : `<div style="width:${String(APRIL_TAG_SIZE)}px;height:${String(APRIL_TAG_SIZE)}px;display:flex;align-items:center;justify-content:center;border:2px dashed #d1d5db;border-radius:12px;color:#9ca3af;font-family:'JetBrains Mono',monospace;font-size:12px;text-align:center;padding:1rem">Chưa có mã AprilTag</div>`;

    const win = window.open("", "_blank", "width=420,height=560");
    if (!win) {
      notification.error({ title: "Không thể in", description: "Không thể mở cửa sổ in. Vui lòng kiểm tra popup blocker.", placement: "topRight" });
      return;
    }

    const html = `<!DOCTYPE html><html><head><title>In tem kiện hàng - ${safeName}</title><style>` +
      `@page { size: B5 portrait; margin: 0; }` +
      `* { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }` +
      `body { font-family: 'Segoe UI', Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; background: #fff; }` +
      `.label { text-align: center; margin-bottom: 0.8rem; width: ${String(LABEL_SIZE)}px; }` +
      `.label h2 { font-size: 1rem; font-weight: 700; color: #111827; margin-bottom: 0.2rem; }` +
      `.label .meta { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #6b7280; }` +
      `.label-stack { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; padding: 1rem; border: 2px solid #d1d5db; border-radius: 16px; background: #fff; width: ${String(LABEL_SIZE)}px; height: ${String(LABEL_SIZE)}px; box-sizing: border-box; }` +
      `.label-stack .caption { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #9ca3af; }` +
      `@media print { body { padding: 0.8rem; } .no-print { display: none !important; } .label-stack { border: 2px solid #000; } }` +
      `</style></head><body>` +
      `<div class="label"><h2>${safeName}</h2><div class="meta">AprilTag: ${hasTag ? '#' + String(tagId) : '—'} · Trạng thái: ${statusLabel}</div></div>` +
      `<div class="label-stack">${aprilTagMarkup}<div class="caption">AprilTag (2/3)</div>${hiddenQr}<div class="caption">QR · mongoId (1/3)</div></div>` +
      `<br /><div class="no-print" style="display:flex;flex-direction:column;align-items:center;gap:0.5rem">` +
      `<button onclick="window.print()" style="padding:9px 22px;font-size:13px;border-radius:7px;border:1px solid #d1d5db;background:#f9fafb;cursor:pointer">In tem</button>` +
      `<button onclick="window.close()" style="padding:9px 22px;font-size:13px;border-radius:7px;border:none;background:#2563eb;color:#fff;cursor:pointer">Đóng</button>` +
      `</div></body></html>`;

    win.document.open();
    win.document.write(html);
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
      <Layout style={{ minHeight: "100vh", background: "var(--bg-void)" }}>
      <Content
        className="p-4! md:p-8!"
        style={{
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ maxWidth: 640, width: "100%" }}>
          {/* Back */}
          <Button
            type="link"
            icon={<ArrowLeftOutlined />}
            onClick={() => router.back()}
            style={{ marginBottom: "1rem", paddingLeft: 0, fontSize: "15px", color: "var(--text-secondary)" }}
          >
            Quay lại danh sách
          </Button>

          <Card
            variant="borderless"
            style={{
              borderRadius: 16,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-dim)",
              boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
            }}
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
                  className="flex flex-col md:flex-row md:items-center md:justify-between flex-wrap gap-3 md:gap-4"
                  style={{
                    marginBottom: "1.5rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", minWidth: 0 }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 14,
                        background: "var(--accent-dim)",
                        border: "1px solid var(--accent-border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <PackageIcon size={28} style={{ color: "var(--accent)" }} />
                    </div>
                    <h2
                      style={{
                        margin: 0,
                        fontWeight: 800,
                        fontSize: "1.4rem",
                        lineHeight: 1.3,
                        color: "var(--text-primary)",
                        fontFamily: "'JetBrains Mono', monospace",
                        letterSpacing: "-0.02em",
                      }}
                    >
                      {pkg.packageName}
                    </h2>
                  </div>

                  <div className="flex flex-col md:flex-row gap-2 w-full md:w-auto">
                    <Button icon={<Edit3 size={14} />} onClick={handleOpenEdit} className="w-full md:w-auto" style={{ borderRadius: 8 }}>
                      Sửa tên
                    </Button>
                    <Button
                      icon={<CheckCircleOutlined />}
                      onClick={handleFinishClick}
                      disabled={pkg.status === "FINISHED"}
                      className="w-full md:w-auto"
                      style={{ borderRadius: 8 }}
                    >
                      Hoàn thành
                    </Button>
                    <Button
                      type="primary"
                      icon={<QrCode size={14} />}
                      onClick={handlePrint}
                      disabled={pkg.tagId === null || pkg.tagId === undefined}
                      className="w-full md:w-auto"
                      style={{ background: "var(--accent)", color: "#080b10", borderRadius: 8, fontWeight: 700, display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      In tem
                    </Button>
                  </div>
                </div>

                <div style={{ borderTop: "1px solid var(--border-dim)", paddingTop: "0.5rem" }}>
                  <InfoRow
                    label="Tên kiện hàng:"
                    value={<span style={{ fontWeight: 700 }}>{pkg.packageName}</span>}
                  />
                  <InfoRow label="Trạng thái:" value={<StatusTag status={pkg.status} />} />
                  <InfoRow
                    label="Mã AprilTag:"
                    value={
                      pkg.tagId === null || pkg.tagId === undefined ? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      ) : (
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: "var(--accent)" }}>
                          #{pkg.tagId}
                        </span>
                      )
                    }
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
                  className="w-full"
                  style={{
                    background: "var(--bg-raised)",
                    border: "1px dashed var(--border-mid)",
                    borderRadius: 12,
                    marginTop: "1.5rem",
                  }}
                  styles={{ body: { padding: "1.25rem", textAlign: "center" } }}
                >
                  <p
                    style={{
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      marginBottom: "0.75rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    Mã QR — dữ liệu bên trong
                  </p>
                  <code
                    style={{
                      display: "block",
                      background: "var(--bg-void)",
                      color: "var(--success)",
                      padding: "8px 14px",
                      borderRadius: 8,
                      fontSize: "12px",
                      fontFamily: "'JetBrains Mono', monospace",
                      wordBreak: "break-all",
                      marginBottom: "0.75rem",
                      border: "1px solid var(--border-dim)",
                    }}
                  >
                    {qrPayload}
                  </code>
                  <Tooltip title="Quét mã QR này bằng thiết bị cầm tay để nhận diện kiện hàng">
                    <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>
                      Quét mã QR này để nhận diện kiện hàng
                    </p>
                  </Tooltip>
                </Card>

                {/* Hidden QR for the print popup to read via [data-print-qr] */}
                <div data-print-qr style={{ display: "none" }}>
                  <QRCodeSVG value={qrPayload} size={QR_SIZE} level="M" includeMargin />
                </div>
              </>
            )}
          </Card>
        </div>
      </Content>

      {/* Edit Modal — form instance lives here, only connected when open */}
      {isEditModalOpen && (
        <Modal
          title={
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
              <Edit3 size={18} style={{ color: "var(--accent)" }} />
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
          width="calc(100vw - 32px)"
          style={{ maxWidth: 720, top: 16 }}
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
                style={{ background: "var(--accent)", color: "#080b10", borderRadius: 10, fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}
              >
                <SaveOutlined /> Lưu thay đổi
              </Button>
            </div>
          </Form>
        </Modal>
      )}

      {/* Confirm Modal */}
      <Modal
        title={<span style={{ fontWeight: 700, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>Xác nhận cập nhật kiện hàng?</span>}
        open={isConfirmOpen}
        onCancel={() => setIsConfirmOpen(false)}
        centered
        width="calc(100vw - 32px)"
        style={{ maxWidth: 720, top: 16 }}
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
              style={{ background: "var(--accent)", color: "#080b10", borderRadius: 10, fontWeight: 700 }}
            >
              Xác nhận cập nhật
            </Button>
          </div>
        }
      >
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, fontFamily: "'JetBrains Mono', monospace" }}>Bạn có chắc chắn muốn cập nhật kiện hàng này?</p>
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem 1rem",
            background: "var(--bg-raised)",
            borderRadius: 10,
            border: "1px solid var(--border-dim)",
          }}
        >
          <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "4px", fontFamily: "'JetBrains Mono', monospace" }}>Tên kiện hàng mới:</p>
          <strong style={{ color: "var(--accent)" }}>{pendingName}</strong>
        </div>
      </Modal>

      {/* Print Modal */}
      <Modal
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
            <PrinterOutlined style={{ color: "var(--accent)" }} />
            In tem kiện hàng
          </div>
        }
        open={isPrintModalOpen}
        onCancel={() => setIsPrintModalOpen(false)}
        centered
        width="calc(100vw - 32px)"
        style={{ maxWidth: 720, top: 16 }}
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
              disabled={pkg?.tagId === null || pkg?.tagId === undefined}
              style={{ background: "var(--accent)", color: "#080b10", borderRadius: 10, fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}
            >
              In tem
            </Button>
          </div>
        }
      >
        {pkg && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0.5rem 0" }}>
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: "0.5rem",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {pkg.packageName}
            </p>

            <div
              style={{
                width: LABEL_SIZE,
                height: LABEL_SIZE,
                border: "2px dashed var(--border-mid)",
                borderRadius: 16,
                background: "#fff",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                padding: "1rem",
                boxSizing: "border-box",
              }}
            >
              {pkg.tagId !== null && pkg.tagId !== undefined ? (
                <AprilTag id={pkg.tagId} sizePx={APRIL_TAG_SIZE} />
              ) : (
                <div style={{ width: APRIL_TAG_SIZE, height: APRIL_TAG_SIZE, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  Chưa có mã AprilTag
                </div>
              )}
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#9ca3af" }}>
                AprilTag #{pkg.tagId ?? "—"} (2/3)
              </div>
              <QRCodeSVG value={qrPayload} size={QR_SIZE} level="M" includeMargin bgColor="#ffffff" fgColor="#1f2937" />
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#9ca3af" }}>
                QR · mongoId (1/3)
              </div>
            </div>

            <p style={{ fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "0.75rem", fontFamily: "'JetBrains Mono', monospace" }}>
              Tem gồm AprilTag (mã số #{pkg.tagId ?? "—"}) cho robot vision và QR (mongoId) cho máy quét cầm tay.
            </p>
          </div>
        )}
      </Modal>

      {/* Finish confirm modal */}
      <Modal
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
            <CheckCircleOutlined style={{ color: "var(--success)" }} />
            Đánh dấu hoàn thành?
          </div>
        }
        open={isFinishConfirmOpen}
        onCancel={() => setIsFinishConfirmOpen(false)}
        centered
        width="calc(100vw - 32px)"
        style={{ maxWidth: 720, top: 16 }}
        footer={
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
            <Button size="large" onClick={() => setIsFinishConfirmOpen(false)} style={{ borderRadius: 10 }}>
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              loading={isPatching}
              onClick={handleConfirmFinish}
              style={{ background: "var(--success)", color: "#080b10", borderRadius: 10, fontWeight: 700 }}
            >
              Xác nhận hoàn thành
            </Button>
          </div>
        }
      >
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, fontFamily: "'JetBrains Mono', monospace" }}>
          Kiện hàng sẽ chuyển sang trạng thái <strong style={{ color: "var(--success)" }}>Hoàn thành</strong> và mã AprilTag sẽ được giải phóng về pool.
        </p>
        {pkg && (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem 1rem",
              background: "var(--bg-raised)",
              borderRadius: 10,
              border: "1px solid var(--border-dim)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <div>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "4px", fontFamily: "'JetBrains Mono', monospace" }}>Kiện hàng</p>
              <strong style={{ color: "var(--accent)" }}>{pkg.packageName}</strong>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "4px", fontFamily: "'JetBrains Mono', monospace" }}>Mã AprilTag sẽ giải phóng</p>
              <strong style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--text-primary)" }}>
                {pkg.tagId === null || pkg.tagId === undefined ? "—" : `#${String(pkg.tagId)}`}
              </strong>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
    </ConfigProvider>
  );
}
