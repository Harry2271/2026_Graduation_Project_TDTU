import { useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PackageCard } from '@/components/PackageCard';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';
import { useTheme } from '@/hooks/use-theme';
import type { ZoneCode } from '@/types/inventory';

const ZONE_FILTER_OPTIONS = ['Tất cả', 'S1', 'S2', 'S3', 'S4', 'Chưa xếp'] as const;

export default function PackageListScreen() {
  const router = useRouter();
  const theme = useTheme();
  const packages = usePackageStore((s) => s.packages);
  const isLoading = usePackageStore((s) => s.isLoading);
  const load = usePackageStore((s) => s.load);
  const create = usePackageStore((s) => s.create);
  const assign = usePackageStore((s) => s.assign);
  const finish = usePackageStore((s) => s.finish);
  const remove = usePackageStore((s) => s.remove);

  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState<string>('Tất cả');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const filtered = packages.filter((pkg) => {
    if (search) {
      const term = search.toLowerCase();
      if (
        !pkg.packageName.toLowerCase().includes(term) &&
        !pkg._id.toLowerCase().includes(term)
      )
        return false;
    }
    if (zoneFilter === 'Chưa xếp') return pkg.zoneCode === null;
    if (zoneFilter !== 'Tất cả') return pkg.zoneCode === zoneFilter;
    return true;
  });

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await create(newName.trim());
      setAddModalOpen(false);
      setNewName('');
    } catch {
      // store handles error
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <View style={styles.topBar}>
        <Text style={[styles.title, { color: theme.text }]}>KIỆN HÀNG</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: theme.primary }]}
          onPress={() => setAddModalOpen(true)}
          activeOpacity={0.8}>
          <Text style={[styles.addBtnText, { color: '#080B10' }]}>+ Thêm</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Tìm theo tên hoặc _id..."
        placeholderTextColor={theme.textMuted}
        style={[styles.search, {
          backgroundColor: theme.surfaceAlt,
          borderColor: theme.border,
          color: theme.text,
        }]}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={() => void load()} tintColor={theme.primary} />
        }>
        <View style={styles.filterRow}>
          {ZONE_FILTER_OPTIONS.map((opt) => {
            const active = zoneFilter === opt;
            return (
              <TouchableOpacity
                key={opt}
                style={[styles.filterChip, {
                  borderColor: active ? theme.primary : theme.border,
                  backgroundColor: active ? `${theme.primary}15` : theme.surfaceAlt,
                }]}
                onPress={() => setZoneFilter(opt)}
                activeOpacity={0.7}>
                <Text style={[styles.filterText, { color: active ? theme.primary : theme.textMuted }]}>{opt}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {filtered.length === 0 && !isLoading ? (
          <Text style={[styles.empty, { color: theme.textMuted }]}>
            {search || zoneFilter !== 'Tất cả' ? 'Không tìm thấy kiện hàng phù hợp.' : 'Chưa có kiện hàng nào.'}
          </Text>
        ) : (
          filtered.map((pkg) => (
            <PackageCard
              key={pkg._id}
              pkg={pkg}
              onPress={() => router.push(`/packages/${pkg._id}` as never)}
              onAssignZone={async (zone) => { await assign(pkg._id, zone); }}
              onFinish={async () => { await finish(pkg._id); }}
              onDelete={async () => { await remove(pkg._id); }}
            />
          ))
        )}
      </ScrollView>

      <Modal visible={addModalOpen} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Thêm kiện hàng mới</Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Tên kiện hàng..."
              placeholderTextColor={theme.textMuted}
              style={[styles.modalInput, {
                backgroundColor: theme.surfaceAlt,
                borderColor: theme.border,
                color: theme.text,
              }]}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelBtn, { borderColor: theme.borderHover }]}
                onPress={() => { setAddModalOpen(false); setNewName(''); }}>
                <Text style={[styles.modalCancelText, { color: theme.textSecondary }]}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmBtn, { backgroundColor: theme.primary }, creating && { opacity: 0.5 }]}
                disabled={creating || !newName.trim()}
                onPress={() => void handleCreate()}>
                {creating ? (
                  <ActivityIndicator color="#080B10" size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>Thêm</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, maxWidth: MaxContentWidth, alignSelf: 'center', width: '100%' },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  title: { fontSize: 22, fontWeight: '900', fontFamily: 'monospace', letterSpacing: 1 },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addBtnText: { fontWeight: '800', fontSize: 12, fontFamily: 'monospace' },
  search: {
    marginHorizontal: Spacing.four,
    marginTop: Spacing.two,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  scrollContent: {
    padding: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.four,
    gap: 8,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  empty: { fontFamily: 'monospace', fontSize: 12, paddingVertical: 24, textAlign: 'center' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalBox: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  modalInput: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 14,
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  modalCancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  modalCancelText: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  modalConfirmBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  modalConfirmText: { color: '#080B10', fontSize: 13, fontWeight: '800', fontFamily: 'monospace' },
});
