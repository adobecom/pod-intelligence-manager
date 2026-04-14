import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Text } from "@react-spectrum/s2";

interface RelativeTimeProps {
  timestamp: string | null;
}

export function RelativeTime({ timestamp }: RelativeTimeProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!timestamp) return <Text>—</Text>;

  return (
    <Text>
      {formatDistanceToNow(new Date(timestamp), { addSuffix: true })}
    </Text>
  );
}
