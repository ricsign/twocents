/**
 * Wall, skirting board and floor. Three absolutely positioned bands with
 * repeating-linear-gradients standing in for wallpaper seams and floorboards —
 * cheaper than a tileset, and it scales with the room instead of tiling against
 * it. Purely decorative; the room above it is already `aria-hidden`.
 */

export function RoomBackdrop() {
  return (
    <>
      <div
        className="absolute inset-x-0 top-0 h-[220px] bg-wall"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(43,30,20,0.08) 0 4px, transparent 4px 56px)",
        }}
      />
      <div className="absolute inset-x-0 top-[220px] h-4 border-t-4 border-b-4 border-ink bg-wood-deep" />
      <div
        className="absolute inset-x-0 top-[244px] bottom-0 bg-wood"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(43,30,20,0.16) 0 4px, transparent 4px 44px), repeating-linear-gradient(90deg, rgba(43,30,20,0.10) 0 4px, transparent 4px 132px)",
        }}
      />
    </>
  );
}
