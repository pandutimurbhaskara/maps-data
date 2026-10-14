package tiles

import (
	"encoding/binary"
	"fmt"
	"math"
	"sort"

	"google.golang.org/protobuf/encoding/protowire"
)

// SpatialTile is a CARTO spatial-index tile (MIME application/vnd.carto-spatial-tile).
// Props must be nil or index-aligned with Cells; each NumericProps slice has len(Cells) values.
//
// Wire format (ledger A6), "bytes" fields hold raw little-endian arrays:
//
//	Tile        { 1: scheme varint (ignored by the client)  2: Cells }
//	Cells       { 1: Indices  2: repeated Props (one per cell)  3: repeated NumericProp }
//	Indices     { 1: bytes = uint64[] }
//	Props       { 1: repeated KV }   KV { 1: key  2: value }
//	NumericProp { 1: key  2: Doubles }   Doubles { 1: bytes = float64[] }
type SpatialTile struct {
	Cells        []uint64
	Props        []map[string]string
	NumericProps map[string][]float64
}

func appendMsg(b []byte, field protowire.Number, msg []byte) []byte {
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendBytes(b, msg)
}

func appendStr(b []byte, field protowire.Number, s string) []byte {
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func (t SpatialTile) Encode() []byte {
	idx := make([]byte, 0, 8*len(t.Cells))
	for _, c := range t.Cells {
		idx = binary.LittleEndian.AppendUint64(idx, c)
	}
	cells := appendMsg(nil, 1, appendMsg(nil, 1, idx))
	for i := range t.Cells {
		var props []byte
		if t.Props != nil {
			for _, k := range sortedKeys(t.Props[i]) {
				props = appendMsg(props, 1, appendStr(appendStr(nil, 1, k), 2, t.Props[i][k]))
			}
		}
		cells = appendMsg(cells, 2, props) // one (possibly empty) Props per cell keeps indices aligned
	}
	for _, k := range sortedKeys(t.NumericProps) {
		vals := make([]byte, 0, 8*len(t.NumericProps[k]))
		for _, v := range t.NumericProps[k] {
			vals = binary.LittleEndian.AppendUint64(vals, math.Float64bits(v))
		}
		cells = appendMsg(cells, 3, appendMsg(appendStr(nil, 1, k), 2, appendMsg(nil, 1, vals)))
	}
	return appendMsg(nil, 2, cells)
}

// DecodeSpatialTile is the inverse of Encode; used by tests and for debugging tiles.
func DecodeSpatialTile(b []byte) (SpatialTile, error) {
	t := SpatialTile{NumericProps: map[string][]float64{}}
	err := eachField(b, func(num protowire.Number, v []byte) error {
		if num != 2 {
			return nil
		}
		return eachField(v, func(num protowire.Number, v []byte) error {
			switch num {
			case 1:
				raw, err := bytesField1(v)
				for i := 0; i+8 <= len(raw); i += 8 {
					t.Cells = append(t.Cells, binary.LittleEndian.Uint64(raw[i:]))
				}
				return err
			case 2:
				props := map[string]string{}
				err := eachField(v, func(_ protowire.Number, kv []byte) error {
					var k, val string
					err := eachField(kv, func(num protowire.Number, s []byte) error {
						if num == 1 {
							k = string(s)
						} else if num == 2 {
							val = string(s)
						}
						return nil
					})
					props[k] = val
					return err
				})
				t.Props = append(t.Props, props)
				return err
			case 3:
				var key string
				var vals []float64
				err := eachField(v, func(num protowire.Number, f []byte) error {
					if num == 1 {
						key = string(f)
						return nil
					}
					raw, err := bytesField1(f)
					for i := 0; i+8 <= len(raw); i += 8 {
						vals = append(vals, math.Float64frombits(binary.LittleEndian.Uint64(raw[i:])))
					}
					return err
				})
				t.NumericProps[key] = vals
				return err
			}
			return nil
		})
	})
	return t, err
}

// eachField calls fn for every length-delimited field and skips all other wire types.
func eachField(b []byte, fn func(protowire.Number, []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
		}
		b = b[n:]
		if typ != protowire.BytesType {
			n = protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
			}
			b = b[n:]
			continue
		}
		v, n := protowire.ConsumeBytes(b)
		if n < 0 {
			return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
		}
		b = b[n:]
		if err := fn(num, v); err != nil {
			return err
		}
	}
	return nil
}

func bytesField1(msg []byte) ([]byte, error) {
	var out []byte
	err := eachField(msg, func(num protowire.Number, v []byte) error {
		if num == 1 {
			out = v
		}
		return nil
	})
	return out, err
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
