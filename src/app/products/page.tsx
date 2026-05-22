"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Layout,
  Button,
  Input,
  Modal,
  Form,
  notification,
  Empty,
  Popconfirm,
  Badge,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Plus,
  Search,
  Trash2,
  Edit3,
  QrCode,
  Layers,
  MapPin,
} from "lucide-react";
import {
  useGetPackagesQuery,
  useCreatePackageMutation,
  useDeletePackageMutation,
  useAssignPackageToSlotMutation,
} from "@/store/services/inventoryApi";
import { useGetAllSlotsQuery } from "@/store/services/inventoryApi";
import type { PackageItem, Package } from "@/types/inventory";
import { parseSlotCode, toSlotCode } from "@/types/inventory";

const { Content } = Layout;

export default function ProductsPage() {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState("");
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: packages = [], isLoading } = useGetPackagesQuery();
  const { data: slots = [] } = useGetAllSlotsQuery();
  const [createPackage, { isLoading: isCreating }] = useCreatePackageMutation();
  const [deletePackage, { isLoading: isDeleting }] = useDeletePackageMutation();
  const [assignToSlot, { isLoading: isAssigning }] = useAssignPackageToSlotMutation();

  // ── Assign to shelf modal ─────────────────────────────────────
  const [assignModal, setAssignModal] = useState<{
    pkg: Package;
    shelfId: number | null;
    cell: string | null;
  } | null>(null);

  const openAssignModal = (pkg: Package) => {
    setAssignModal({ pkg, shelfId: null, cell: null });
  };

  const closeAssignModal = () => {
    setAssignModal(null);
  };

  const handleAssign = async () => {
    if (!assignModal?.shelfId || !assignModal?.cell || !assignModal?.pkg) {
      notification.warning({ message: "Chưa chọn vị trí", description: "Vui lòng chọn kệ và ô.", placement: "topRight" });
      return;
    }
    try {
      const slotCode = toSlotCode(assignModal.shelfId, assignModal.cell);
      await assignToSlot({ slotCode, packageId: assignModal.pkg._id }).unwrap();
      notification.success({ message: "Thành công", description: "Xếp kiện hàng vào kệ thành công!", placement: "topRight" });
      closeAssignModal();
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        "Xếp kiện hàng thất bại!";
      notification.error({ message: "Thất bại", description: errMsg, placement: "topRight" });
    }
  };

  // Build set of occupied slot keys "shelfId-cell"
  const occupiedSet = useMemo(() => {
    const set = new Set<string>();
    slots.forEach((s) => {
      if (s.packageId) {
        const { shelfId, cell } = parseSlotCode(s.code);
        set.add(`${shelfId}-${cell}`);
      }
    });
    return set;
  }, [slots]);

  // Build package → slot map
  const packageMap = useMemo(() => {
    const map: Record<string, PackageItem> = {};
    packages.forEach((pkg) => {
      const slot = slots.find((s) => s.packageId === pkg._id);
      if (slot) {
        const { shelfId, cell } = parseSlotCode(slot.code);
        map[pkg._id] = {
          ...pkg,
          shelfId,
          cell,
          importedAt: pkg.createdAt ?? new Date().toISOString(),
        };
      } else {
        map[pkg._id] = {
          _id: pkg._id,
          packageName: pkg.packageName,
          shelfId: 0,
          cell: "",
          importedAt: pkg.createdAt ?? new Date().toISOString(),
        };
      }
    });
    return map;
  }, [packages, slots]);

  const filteredPackages = useMemo(() => {
    return packages.filter(
      (pkg) =>
        pkg.packageName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        pkg._id.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [packages, searchTerm]);

  const handleAdd = async (values: { packageName: string }) => {
    try {
      await createPackage(values).unwrap();
      notification.success({ message: "Thành công", description: "Thêm kiện hàng thành công!", placement: "topRight" });
      form.resetFields();
      setIsAddModalOpen(false);
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        "Thêm kiện hàng thất bại!";
      notification.error({ message: "Thất bại", description: errMsg, placement: "topRight" });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePackage(id).unwrap();
      notification.success({ message: "Thành công", description: "Xóa kiện hàng thành công!", placement: "topRight" });
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        "Xóa kiện hàng thất bại!";
      notification.error({ message: "Thất bại", description: errMsg, placement: "topRight" });
    }
  };

  const columns: ColumnsType<Package> = [
    {
      title: "STT",
      key: "index",
      width: 64,
      render: (_: unknown, _record: Package, index: number) => (
        <span style={{ color: "#9ca3af", fontWeight: 600 }}>{index + 1}</span>
      ),
    },
    {
      title: "Tên kiện hàng",
      dataIndex: "packageName",
      key: "packageName",
      sorter: (a, b) => a.packageName.localeCompare(b.packageName),
      render: (name: string) => (
        <span style={{ fontWeight: 600, color: "#1f2937" }}>{name}</span>
      ),
    },
    {
      title: "Kệ",
      key: "shelf",
      width: 140,
      render: (_: unknown, record: Package) => {
        const item = packageMap[record._id];
        if (item?.shelfId > 0) {
          return (
            <Tag color="blue" style={{ borderRadius: 6 }}>
              Kệ {item.shelfId} – Ô {item.cell}
            </Tag>
          );
        }
        return (
          <Tag style={{ borderRadius: 6, background: "#f9fafb", color: "#9ca3af", borderColor: "#e5e7eb" }}>
            Chưa xếp kệ
          </Tag>
        );
      },
    },
    {
      title: "Ngày tạo",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 160,
      sorter: (a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return da - db;
      },
      render: (date: string) =>
        date ? (
          <span style={{ color: "#6b7280", fontSize: "13px" }}>
            {new Date(date).toLocaleDateString("vi-VN", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : (
          <span style={{ color: "#d1d5db" }}>—</span>
        ),
    },
    {
      title: "Thao tác",
      key: "actions",
      width: 260,
      fixed: "right",
      render: (_: unknown, record: Package) => {
        const item = packageMap[record._id];
        const notOnShelf = !item || item.shelfId === 0;
        return (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {notOnShelf && (
              <Tooltip title="Xếp kiện hàng vào kệ">
                <Button
                  size="small"
                  icon={<MapPin size={13} />}
                  onClick={() => openAssignModal(record)}
                  style={{ borderRadius: 7, display: "flex", alignItems: "center", gap: "4px" }}
                >
                  Xếp kệ
                </Button>
              </Tooltip>
            )}
            <Button
              size="small"
              icon={<Edit3 size={13} />}
              onClick={() => router.push(`/products/${record._id}`)}
              style={{ borderRadius: 7, display: "flex", alignItems: "center", gap: "4px" }}
            >
              Sửa
            </Button>
            <Button
              size="small"
              icon={<QrCode size={13} />}
              onClick={() => router.push(`/products/${record._id}?action=print`)}
              style={{ borderRadius: 7, display: "flex", alignItems: "center", gap: "4px" }}
            >
              In QR
            </Button>
            <Popconfirm
              title="Xóa kiện hàng?"
              description="Thao tác này không thể hoàn tác."
              okText="Xóa"
              cancelText="Hủy"
              okButtonProps={{ danger: true, loading: isDeleting }}
              onConfirm={() => handleDelete(record._id)}
            >
              <Button size="small" danger icon={<Trash2 size={13} />} style={{ borderRadius: 7 }} />
            </Popconfirm>
          </div>
        );
      },
    },
  ];

  return (
    <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <Content style={{ padding: "2rem", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.5rem",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 800,
                margin: 0,
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Layers size={24} className="text-blue-600" />
              Quản lý kiện hàng
            </h1>
            <p style={{ margin: "4px 0 0", color: "#9ca3af", fontSize: "14px" }}>
              Thêm, sửa, xóa và in mã QR cho từng kiện hàng trong kho
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <Badge count={packages.length} style={{ backgroundColor: "#2563eb" }}>
              <span
                style={{
                  background: "#eff6ff",
                  color: "#2563eb",
                  padding: "6px 16px",
                  borderRadius: "9999px",
                  fontWeight: 700,
                  fontSize: "14px",
                  border: "1px solid #bfdbfe",
                }}
              >
                {packages.length} kiện
              </span>
            </Badge>

            <Button
              type="primary"
              icon={<Plus size={16} />}
              size="large"
              onClick={() => setIsAddModalOpen(true)}
              style={{
                background: "#2563eb",
                borderRadius: "10px",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              Thêm kiện hàng
            </Button>
          </div>
        </div>

        {/* Search */}
        <div style={{ marginBottom: "1rem" }}>
          <Input
            size="large"
            placeholder="Tìm kiếm theo tên kiện hàng..."
            prefix={<Search size={18} style={{ color: "#9ca3af" }} />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            allowClear
            style={{ borderRadius: "10px", maxWidth: 360 }}
          />
        </div>

        {/* Table */}
        {!isLoading && filteredPackages.length === 0 ? (
          <Empty
            description={
              searchTerm
                ? "Không tìm thấy kiện hàng nào phù hợp."
                : "Chưa có kiện hàng nào trong kho."
            }
            style={{ marginTop: "3rem" }}
          />
        ) : (
          <Table<Package>
            columns={columns}
            dataSource={filteredPackages}
            rowKey="_id"
            loading={isLoading}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              showTotal: (total) => (
                <span style={{ color: "#9ca3af" }}>
                  Tổng cộng <strong style={{ color: "#374151" }}>{total}</strong> kiện hàng
                </span>
              ),
            }}
            scroll={{ x: 640 }}
            style={{
              borderRadius: 12,
              overflow: "hidden",
            }}
          />
        )}
      </Content>

      {/* Assign to Shelf Modal */}
      <Modal
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
            <MapPin size={18} style={{ color: "#2563eb" }} />
            Xếp kiện hàng vào kệ
          </div>
        }
        open={!!assignModal}
        onCancel={closeAssignModal}
        centered
        styles={{ body: { paddingTop: "1rem" } }}
        footer={
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
            <Button size="large" onClick={closeAssignModal} style={{ borderRadius: 10 }}>
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              loading={isAssigning}
              onClick={handleAssign}
              disabled={!assignModal?.shelfId || !assignModal?.cell}
              style={{
                background: "#2563eb",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              Xếp vào kệ
            </Button>
          </div>
        }
      >
        {assignModal && (
          <div>
            <p style={{ marginBottom: "1rem", color: "#374151" }}>
              Chọn vị trí cho kiện hàng:{" "}
              <strong style={{ color: "#2563eb" }}>{assignModal.pkg.packageName}</strong>
            </p>

            {/* Shelf selector */}
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "0.5rem", fontWeight: 600 }}>
                1. Chọn kệ
              </p>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {[1, 2, 3, 4].map((shelfId) => (
                  <button
                    key={shelfId}
                    onClick={() =>
                      setAssignModal((prev) => (prev ? { ...prev, shelfId, cell: null } : null))
                    }
                    style={{
                      flex: 1,
                      padding: "0.5rem",
                      borderRadius: 8,
                      border: `2px solid ${assignModal?.shelfId === shelfId ? "#2563eb" : "#e5e7eb"}`,
                      background: assignModal?.shelfId === shelfId ? "#eff6ff" : "#fff",
                      color: assignModal?.shelfId === shelfId ? "#2563eb" : "#374151",
                      fontWeight: 700,
                      fontSize: "14px",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    Kệ {shelfId}
                  </button>
                ))}
              </div>
            </div>

            {/* Cell selector */}
            {assignModal?.shelfId && (
              <div>
                <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "0.5rem", fontWeight: 600 }}>
                  2. Chọn ô
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: "0.5rem",
                  }}
                >
                  {["A", "B", "C", "D"].flatMap((row) =>
                    [1, 2, 3, 4].map((col) => {
                      const cell = `${row}${col}`;
                      const key = `${assignModal.shelfId}-${cell}`;
                      const isOccupied = occupiedSet.has(key);
                      const isSelected = assignModal.cell === cell;
                      return (
                        <button
                          key={cell}
                          onClick={() =>
                            !isOccupied &&
                            setAssignModal((prev) => (prev ? { ...prev, cell } : null))
                          }
                          disabled={isOccupied}
                          style={{
                            padding: "0.6rem 0.25rem",
                            borderRadius: 8,
                            border: `2px solid ${
                              isSelected
                                ? "#2563eb"
                                : isOccupied
                                ? "#f3f4f6"
                                : "#d1d5db"
                            }`,
                            background: isSelected
                              ? "#2563eb"
                              : isOccupied
                              ? "#f9fafb"
                              : "#fff",
                            color: isSelected
                              ? "#fff"
                              : isOccupied
                              ? "#d1d5db"
                              : "#374151",
                            fontWeight: 700,
                            fontSize: "13px",
                            cursor: isOccupied ? "not-allowed" : "pointer",
                            textDecoration: isOccupied ? "line-through" : "none",
                            transition: "all 0.15s",
                          }}
                        >
                          {cell}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Add Package Modal */}
      <Modal
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
            <Plus size={18} style={{ color: "#2563eb" }} />
            Thêm kiện hàng mới
          </div>
        }
        open={isAddModalOpen}
        onCancel={() => {
          setIsAddModalOpen(false);
          form.resetFields();
        }}
        footer={null}
        centered
        styles={{ body: { paddingTop: "1rem" } }}
      >
        <Form
          form={isAddModalOpen ? form : undefined}
          layout="vertical"
          onFinish={handleAdd}
          style={{ marginTop: "1rem" }}
        >
          <Form.Item
            name="packageName"
            label="Tên kiện hàng"
            rules={[{ required: true, message: "Vui lòng nhập tên kiện hàng" }]}
          >
            <Input
              placeholder="Ví dụ: Kiện hàng #001"
              size="large"
              style={{ borderRadius: 10 }}
            />
          </Form.Item>

          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1rem" }}>
            <Button
              size="large"
              onClick={() => {
                setIsAddModalOpen(false);
                form.resetFields();
              }}
              style={{ borderRadius: 10 }}
            >
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              htmlType="submit"
              loading={isCreating}
              style={{
                background: "#2563eb",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              Thêm kiện hàng
            </Button>
          </div>
        </Form>
      </Modal>
    </Layout>
  );
}
