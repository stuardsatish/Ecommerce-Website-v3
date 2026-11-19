export const CUSTOMER_CHANNELS = [
  { value: 'Retail', label: 'Online customer', color: '#0F4C4C' },
  { value: 'Friends', label: 'Friends', color: '#5BA4A4' },
  { value: 'Retailer', label: 'Retail business', color: '#D97706' },
  { value: 'Wholesale', label: 'Wholesale buyer', color: '#BE413B' },
]
export const channelLabel = (value) => CUSTOMER_CHANNELS.find((c) => c.value === value)?.label || 'Unassigned'