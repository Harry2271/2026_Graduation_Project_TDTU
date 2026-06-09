'use client';

import { useState, FormEvent } from 'react';
import styles from './page.module.css';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage('');
    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(body.message || 'Đăng ký thất bại');
        return;
      }
      setMessage('Đăng ký thành công! Vui lòng chờ quản trị viên duyệt tài khoản.');
      setEmail('');
      setPassword('');
    } catch {
      setMessage('Không thể kết nối đến server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Đăng ký</h1>
        {message && <p className={styles.message}>{message}</p>}
        <input
          className={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          className={styles.input}
          type="password"
          placeholder="Mật khẩu (tối thiểu 6 ký tự)"
          value={password}
          onChange={e => setPassword(e.target.value)}
          minLength={6}
          required
        />
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? 'Đang xử lý...' : 'Đăng ký'}
        </button>
        <p className={styles.link}>
          Đã có tài khoản? <a href="/login">Đăng nhập</a>
        </p>
      </form>
    </div>
  );
}
