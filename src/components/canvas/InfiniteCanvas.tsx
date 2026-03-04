'use client';

import { Tldraw } from 'tldraw';
import 'tldraw/tldraw.css';

export default function InfiniteCanvas() {
  return (
    <div className="fixed inset-0">
      <Tldraw />
    </div>
  );
}
