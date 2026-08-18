'use client';

import type { ReactNode } from 'react';
import { Card, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';

export interface TechnicalTableRow {
  key: string;
  [field: string]: string;
}

interface TechnicalPageShellProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}

interface TechnicalSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

interface TechnicalPanelProps {
  children: ReactNode;
  className?: string;
}

interface MetricCardProps {
  label: string;
  value: string;
  detail?: string;
  color?: string;
}

interface DiagramPanelProps {
  label: string;
  caption: string;
  children: ReactNode;
}

interface TechnicalTableProps {
  columns: ColumnsType<TechnicalTableRow>;
  rows: TechnicalTableRow[];
  ariaLabel: string;
}

export function TechnicalPageShell({ eyebrow, title, description, icon, children }: TechnicalPageShellProps) {
  return (
    <div className="technical-page flex-1 min-h-0 overflow-y-auto bg-grid-fine" style={{ backgroundColor: 'var(--bg-void)' }}>
      <header className="border-b px-4 py-6 md:px-8 md:py-8" style={{ borderColor: 'var(--border-dim)' }}>
        <div className="mx-auto max-w-[1440px]">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--accent)' }}>
            {icon}
            <span>{eyebrow}</span>
          </div>
          <h1 className="text-display text-2xl md:text-3xl" style={{ color: 'var(--text-primary)' }}>{title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>{description}</p>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] space-y-10 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}

export function TechnicalSection({ title, description, children }: TechnicalSectionProps) {
  return (
    <section className="space-y-6" aria-labelledby={`section-${title}`}>
      <div>
        <h2 id={`section-${title}`} className="text-label border-b pb-2 text-sm" style={{ borderColor: 'var(--accent-border)', color: 'var(--text-primary)' }}>
          {title}
        </h2>
        {description && <p className="mt-2 max-w-3xl text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function TechnicalPanel({ className = '', children }: TechnicalPanelProps) {
  return (
    <Card
      className={`technical-panel ${className}`}
      styles={{ body: { padding: 0 } }}
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border-dim)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025), 0 10px 28px rgba(0,0,0,0.16)',
      }}
    >
      {children}
    </Card>
  );
}

export function MetricCard({ label, value, detail, color = 'var(--accent)' }: MetricCardProps) {
  return (
    <Card className="h-full" styles={{ body: { padding: 16 } }}>
      <p className="text-label">{label}</p>
      <p className="mt-2 text-2xl font-black font-mono" style={{ color }}>{value}</p>
      {detail && <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{detail}</p>}
    </Card>
  );
}

export function DiagramPanel({ label, caption, children }: DiagramPanelProps) {
  return (
    <TechnicalPanel>
      <figure className="overflow-hidden p-3 md:p-5">
        <div className="overflow-x-auto rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.16)' }}>
          <div className="min-w-[680px] pb-1">{children}</div>
        </div>
        <figcaption className="mt-3 text-center text-xs italic" style={{ color: 'var(--text-muted)' }}>
          <span className="sr-only">{label}: </span>{caption}
        </figcaption>
      </figure>
    </TechnicalPanel>
  );
}

export function TechnicalTable({ columns, rows, ariaLabel }: TechnicalTableProps) {
  return (
    <TechnicalPanel>
      <div className="overflow-x-auto">
        <Table<TechnicalTableRow>
          aria-label={ariaLabel}
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
          rowKey="key"
          scroll={{ x: 'max-content' }}
        />
      </div>
    </TechnicalPanel>
  );
}
