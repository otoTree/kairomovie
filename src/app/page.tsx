'use client';

import dynamic from 'next/dynamic';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Dynamic import for Tldraw to avoid SSR issues
const InfiniteCanvas = dynamic(() => import('@/components/canvas/InfiniteCanvas'), {
  ssr: false,
});

export default function Home() {
  const { count, increment, decrement } = useStore();

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* Infinite Canvas Background */}
      <InfiniteCanvas />

      {/* Overlay UI */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none">
        <Card className="w-64 pointer-events-auto">
          <CardHeader>
            <CardTitle>Next.js + Zustand + Canvas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Zustand Count:</span>
              <span className="text-2xl font-bold">{count}</span>
            </div>
            <div className="flex gap-2">
              <Button onClick={decrement} variant="outline" size="sm" className="flex-1">
                -
              </Button>
              <Button onClick={increment} size="sm" className="flex-1">
                +
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This project uses Drizzle ORM (disuzzle) and all shadcn/ui components.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
