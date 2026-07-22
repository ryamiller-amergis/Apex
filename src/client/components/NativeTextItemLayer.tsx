import React from 'react';
import type { NativePdfTextItem } from '../utils/pdfNativeTextItems';
import styles from './NativeTextItemLayer.module.css';

interface NativeTextItemLayerProps {
  items: NativePdfTextItem[];
  onSelect: (item: NativePdfTextItem) => void;
}

export const NativeTextItemLayer: React.FC<NativeTextItemLayerProps> = ({
  items,
  onSelect,
}) => (
  <div
    className={styles.layer}
    data-testid="native-text-item-layer"
    aria-label="Selectable PDF text"
  >
    {items.map((item) => (
      <button
        key={item.id}
        type="button"
        className={styles.item}
        style={{
          left: `${item.geometry.x}%`,
          top: `${item.geometry.y}%`,
          width: `${item.geometry.width}%`,
          height: `${item.geometry.height}%`,
          transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
        }}
        aria-label={`Replace PDF text: ${item.text.slice(0, 80)}`}
        title={item.text}
        data-testid="native-text-item"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(item);
        }}
      />
    ))}
  </div>
);
