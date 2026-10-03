/*
 * Portions of this file are a Kotlin port of the H3 reference library (https://github.com/uber/h3,
 * v4: faceijk.c, coordijk.c, h3Index.c, baseCells.c, latLng.c, vec3d.c).
 * Copyright 2016-2023 Uber Technologies, Inc. Licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 */
package dev.findmyperson.locationcapture.core

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.tan

/**
 * The two H3 cells of a `location_sample` row, computed without a native library.
 *
 * Why a port and not h3-java: h3-java loads a JNI library by unpacking it to a temporary file
 * at run time, and it ships that library for two Android ABIs only. If the load failed on some
 * phone, no sample could be written at all (both cell columns are NOT NULL), in the background,
 * with nobody watching. Indexing one point needs only `latLngToCell` and `cellToParent`, which
 * are a few hundred lines of arithmetic and two tables, so they are ported here and the write
 * path has nothing left that can fail to load.
 *
 * H3Test holds the port to the reference: it must reproduce packages/shared's golden vectors
 * (produced by h3-js) exactly, and agree with h3-java on tens of thousands of random points,
 * the poles, the antimeridian and the neighbourhood of all twelve pentagons.
 *
 * Cells are the 15-character lowercase hex string, as everywhere else in the project.
 */
object H3 {
    /** Resolution of `h3_r7`: H3_RES_MATCH in packages/shared/src/constants.ts. */
    const val RES_MATCH = 7

    /** Resolution of `h3_r5`: H3_RES_SHARD in packages/shared/src/constants.ts. */
    const val RES_SHARD = 5

    class Cells(val h3R7: String, val h3R5: String)

    /**
     * `sampleCells` of packages/shared/src/geo/h3.ts: the res-7 cell of the point and the res-5
     * parent of that cell. The parent is not always the res-5 cell that contains the point.
     */
    fun sampleCells(latDeg: Double, lonDeg: Double): Cells {
        val r7 = latLngToCell(latDeg, lonDeg, RES_MATCH)
        return Cells(toString(r7), toString(cellToParent(r7, RES_SHARD)))
    }

    fun toString(cell: Long): String = java.lang.Long.toHexString(cell)

    // ---- index layout (h3Index.h) ----

    private const val MODE_OFFSET = 59
    private const val RES_OFFSET = 52
    private const val BASE_CELL_OFFSET = 45
    private const val DIGIT_BITS = 3
    private const val MAX_RES = 15
    private const val CELL_MODE = 1L

    /** All fifteen digits set to 7, "unused". */
    private const val ALL_DIGITS_UNUSED = 35184372088831L

    private fun digitShift(res: Int): Int = (MAX_RES - res) * DIGIT_BITS

    private fun pack(res: Int, baseCell: Int, digits: IntArray): Long {
        var h = ALL_DIGITS_UNUSED
        h = h or (CELL_MODE shl MODE_OFFSET)
        h = h or (res.toLong() shl RES_OFFSET)
        h = h or (baseCell.toLong() shl BASE_CELL_OFFSET)
        for (r in 1..res) {
            h = (h and (7L shl digitShift(r)).inv()) or (digits[r].toLong() shl digitShift(r))
        }
        return h
    }

    /** `cellToParent`: lower the resolution and mark the dropped digits unused. */
    fun cellToParent(cell: Long, parentRes: Int): Long {
        val childRes = ((cell ushr RES_OFFSET) and 15L).toInt()
        require(parentRes in 0..childRes) { "parent resolution $parentRes is finer than the cell's $childRes" }
        var h = (cell and (15L shl RES_OFFSET).inv()) or (parentRes.toLong() shl RES_OFFSET)
        for (r in parentRes + 1..childRes) {
            h = h or (7L shl digitShift(r))
        }
        return h
    }

    // ---- latLngToCell ----

    private const val TWO_PI = 6.28318530717958647692528676655900576839433
    private const val EPSILON = 0.0000000000000001
    private const val RSIN60 = 1.1547005383792515290182975610039149112953
    private const val ONE_SEVENTH = 0.14285714285714285714285714285714285
    private const val SQRT7 = 2.6457513110645905905016157536392604257102

    /** Rotation between the axes of even (Class II) and odd (Class III) resolutions. */
    private const val AP7_ROT_RADS = 0.333473172251832115336090755351601070065900389
    private const val INV_RES0_U_GNOMONIC = 2.61803398874989588842

    private const val CENTER_DIGIT = 0
    private const val K_AXES_DIGIT = 1
    private const val INVALID_DIGIT = 7

    /** The largest ijk component a base cell can have on a face. */
    private const val MAX_FACE_COORD = 2

    fun latLngToCell(latDeg: Double, lonDeg: Double, res: Int): Long {
        require(res in 0..MAX_RES) { "resolution $res is out of range" }
        require(latDeg.isFinite() && lonDeg.isFinite()) { "latitude and longitude must be finite" }
        // The same expression h3-js uses, so the golden vectors reproduce to the last bit.
        val lat = latDeg * Math.PI / 180
        val lng = lonDeg * Math.PI / 180

        // _geoToClosestFace
        val cosLat = cos(lat)
        val x = cos(lng) * cosLat
        val y = sin(lng) * cosLat
        val z = sin(lat)
        var face = 0
        var sqd = 5.0
        for (f in 0 until 20) {
            val dx = FACE_CENTER_POINT[f * 3] - x
            val dy = FACE_CENTER_POINT[f * 3 + 1] - y
            val dz = FACE_CENTER_POINT[f * 3 + 2] - z
            val d = dx * dx + dy * dy + dz * dz
            if (d < sqd) {
                face = f
                sqd = d
            }
        }

        // _geoToHex2d
        var r = acos(1 - sqd * 0.5)
        val hexX: Double
        val hexY: Double
        if (r < EPSILON) {
            hexX = 0.0
            hexY = 0.0
        } else {
            val faceLat = FACE_CENTER_GEO[face * 2]
            val faceLng = FACE_CENTER_GEO[face * 2 + 1]
            val azimuth = atan2(
                cos(lat) * sin(lng - faceLng),
                cos(faceLat) * sin(lat) - sin(faceLat) * cos(lat) * cos(lng - faceLng),
            )
            var theta = posAngleRads(FACE_AXIS_AZIMUTH[face] - posAngleRads(azimuth))
            if (res % 2 == 1) theta = posAngleRads(theta - AP7_ROT_RADS)
            r = tan(r) * INV_RES0_U_GNOMONIC
            repeat(res) { r *= SQRT7 }
            hexX = r * cos(theta)
            hexY = r * sin(theta)
        }

        val ijk = hex2dToIjk(hexX, hexY)
        return faceIjkToH3(face, ijk, res)
    }

    private fun posAngleRads(rads: Double): Double {
        var tmp = if (rads < 0.0) rads + TWO_PI else rads
        if (rads >= TWO_PI) tmp -= TWO_PI
        return tmp
    }

    /** `_hex2dToCoordIJK`: the hexagon containing a point of the face's plane, as ijk+. */
    private fun hex2dToIjk(x: Double, y: Double): IntArray {
        val a1 = abs(x)
        val a2 = abs(y)
        val x2 = a2 * RSIN60
        val x1 = a1 + x2 / 2.0
        val m1 = x1.toInt()
        val m2 = x2.toInt()
        val r1 = x1 - m1
        val r2 = x2 - m2

        var i: Int
        var j: Int
        if (r1 < 0.5) {
            if (r1 < 1.0 / 3.0) {
                i = m1
                j = if (r2 < (1.0 + r1) / 2.0) m2 else m2 + 1
            } else {
                j = if (r2 < (1.0 - r1)) m2 else m2 + 1
                i = if ((1.0 - r1) <= r2 && r2 < (2.0 * r1)) m1 + 1 else m1
            }
        } else {
            if (r1 < 2.0 / 3.0) {
                j = if (r2 < (1.0 - r1)) m2 else m2 + 1
                i = if ((2.0 * r1 - 1.0) < r2 && r2 < (1.0 - r1)) m1 else m1 + 1
            } else {
                i = m1 + 1
                j = if (r2 < (r1 / 2.0)) m2 else m2 + 1
            }
        }

        // Fold across the axes: the quantisation above was done in the first quadrant.
        if (x < 0.0) {
            if (j % 2 == 0) {
                val axisI = j / 2
                val diff = i - axisI
                i -= 2 * diff
            } else {
                val axisI = (j + 1) / 2
                val diff = i - axisI
                i -= 2 * diff + 1
            }
        }
        if (y < 0.0) {
            i -= (2 * j + 1) / 2
            j = -j
        }

        val ijk = intArrayOf(i, j, 0)
        normalize(ijk)
        return ijk
    }

    /** `_ijkNormalize`: the smallest non-negative components naming the same hexagon. */
    private fun normalize(c: IntArray) {
        if (c[0] < 0) {
            c[1] -= c[0]
            c[2] -= c[0]
            c[0] = 0
        }
        if (c[1] < 0) {
            c[0] -= c[1]
            c[2] -= c[1]
            c[1] = 0
        }
        if (c[2] < 0) {
            c[0] -= c[2]
            c[1] -= c[2]
            c[2] = 0
        }
        val min = minOf(c[0], c[1], c[2])
        if (min > 0) {
            c[0] -= min
            c[1] -= min
            c[2] -= min
        }
    }

    /** C's `lround`: halves round away from zero. */
    private fun lround(value: Double): Int =
        if (value < 0) -Math.round(-value).toInt() else Math.round(value).toInt()

    /** `_upAp7` (counter-clockwise) and `_upAp7r` (clockwise): the parent hexagon one level up. */
    private fun upAp7(c: IntArray, clockwise: Boolean) {
        val i = c[0] - c[2]
        val j = c[1] - c[2]
        if (clockwise) {
            c[0] = lround((2 * i + j) * ONE_SEVENTH)
            c[1] = lround((3 * j - i) * ONE_SEVENTH)
        } else {
            c[0] = lround((3 * i - j) * ONE_SEVENTH)
            c[1] = lround((i + 2 * j) * ONE_SEVENTH)
        }
        c[2] = 0
        normalize(c)
    }

    /** `_downAp7` and `_downAp7r`: the hexagon at the centre of this one, one level down. */
    private fun downAp7(c: IntArray, clockwise: Boolean) {
        val i = c[0]
        val j = c[1]
        val k = c[2]
        if (clockwise) {
            c[0] = 3 * i + k
            c[1] = i + 3 * j
            c[2] = j + 3 * k
        } else {
            c[0] = 3 * i + j
            c[1] = 3 * j + k
            c[2] = i + 3 * k
        }
        normalize(c)
    }

    /** `_unitIjkToDigit`: UNIT_VECS[d] is (d's bit 2, bit 1, bit 0), so the digit is those bits. */
    private fun unitIjkToDigit(i: Int, j: Int, k: Int): Int {
        val c = intArrayOf(i, j, k)
        normalize(c)
        if (c[0] > 1 || c[1] > 1 || c[2] > 1) return INVALID_DIGIT
        return c[0] * 4 + c[1] * 2 + c[2]
    }

    private val ROTATE_60_CCW = intArrayOf(0, 5, 3, 1, 6, 4, 2, 7)
    private val ROTATE_60_CW = intArrayOf(0, 3, 6, 2, 5, 1, 4, 7)

    private fun rotateAll(digits: IntArray, res: Int, table: IntArray) {
        for (r in 1..res) digits[r] = table[digits[r]]
    }

    private fun leadingNonZeroDigit(digits: IntArray, res: Int): Int {
        for (r in 1..res) if (digits[r] != 0) return digits[r]
        return CENTER_DIGIT
    }

    /** `_h3RotatePent60ccw`: a rotation about a pentagon, which has no k-axis sub-sequence. */
    private fun rotatePent60ccw(digits: IntArray, res: Int) {
        var foundFirstNonZero = false
        for (r in 1..res) {
            digits[r] = ROTATE_60_CCW[digits[r]]
            if (!foundFirstNonZero && digits[r] != 0) {
                foundFirstNonZero = true
                if (leadingNonZeroDigit(digits, res) == K_AXES_DIGIT) rotateAll(digits, res, ROTATE_60_CCW)
            }
        }
    }

    /** `_faceIjkToH3`. */
    private fun faceIjkToH3(face: Int, ijk: IntArray, res: Int): Long {
        val digits = IntArray(MAX_RES + 1)
        val last = IntArray(3)
        val center = IntArray(3)

        // Build the digits from the finest resolution up. After the loop `ijk` is the base cell.
        for (r in res - 1 downTo 0) {
            ijk.copyInto(last)
            val clockwise = (r + 1) % 2 == 0
            upAp7(ijk, clockwise)
            ijk.copyInto(center)
            downAp7(center, clockwise)
            digits[r + 1] = unitIjkToDigit(last[0] - center[0], last[1] - center[1], last[2] - center[2])
        }

        check(ijk[0] <= MAX_FACE_COORD && ijk[1] <= MAX_FACE_COORD && ijk[2] <= MAX_FACE_COORD) {
            "point fell outside its icosahedron face"
        }
        val entry = FACE_IJK_BASE_CELLS[face * 27 + ijk[0] * 9 + ijk[1] * 3 + ijk[2]]
        val baseCell = entry shr 3
        val rotations = entry and 7

        val pentagon = PENTAGONS.firstOrNull { it[0] == baseCell }
        if (pentagon != null) {
            // Force the index out of the missing k-axis sub-sequence.
            if (leadingNonZeroDigit(digits, res) == K_AXES_DIGIT) {
                val cwOffsetFace = pentagon[1] == face || pentagon[2] == face
                rotateAll(digits, res, if (cwOffsetFace) ROTATE_60_CW else ROTATE_60_CCW)
            }
            repeat(rotations) { rotatePent60ccw(digits, res) }
        } else {
            repeat(rotations) { rotateAll(digits, res, ROTATE_60_CCW) }
        }
        return pack(res, baseCell, digits)
    }

    // ---- tables (faceijk.c, baseCells.c) ----

    /** Icosahedron face centres, (lat, lng) in radians. */
    private val FACE_CENTER_GEO = doubleArrayOf(
        0.803582649718989942, 1.248397419617396099,
        1.307747883455638156, 2.536945009877921159,
        1.054751253523952054, -1.347517358900396623,
        0.600191595538186799, -0.450603909469755746,
        0.491715428198773866, 0.401988202911306943,
        0.172745327415618701, 1.678146885280433686,
        0.605929321571350690, 2.953923329812411617,
        0.427370518328979641, -1.888876200336285401,
        -0.079066118549212831, -0.733429513380867741,
        -0.230961644455383637, 0.506495587332349035,
        0.079066118549212831, 2.408163140208925497,
        0.230961644455383637, -2.635097066257444203,
        -0.172745327415618701, -1.463445768309359553,
        -0.605929321571350690, -0.187669323777381622,
        -0.427370518328979641, 1.252716453253507838,
        -0.600191595538186799, 2.690988744120037492,
        -0.491715428198773866, -2.739604450678486295,
        -0.803582649718989942, -1.893195233972397139,
        -1.307747883455638156, -0.604647643711872080,
        -1.054751253523952054, 1.794075294689396615,
    )

    /** Icosahedron face centres, (x, y, z) on the unit sphere. */
    private val FACE_CENTER_POINT = doubleArrayOf(
        0.2199307791404606, 0.6583691780274996, 0.7198475378926182,
        -0.2139234834501421, 0.1478171829550703, 0.9656017935214205,
        0.1092625278784797, -0.4811951572873210, 0.8697775121287253,
        0.7428567301586791, -0.3593941678278028, 0.5648005936517033,
        0.8112534709140969, 0.3448953237639384, 0.4721387736413930,
        -0.1055498149613921, 0.9794457296411413, 0.1718874610009365,
        -0.8075407579970092, 0.1533552485898818, 0.5695261994882688,
        -0.2846148069787907, -0.8644080972654206, 0.4144792552473539,
        0.7405621473854482, -0.6673299564565524, -0.0789837646326737,
        0.8512303986474293, 0.4722343788582681, -0.2289137388687808,
        -0.7405621473854481, 0.6673299564565524, 0.0789837646326737,
        -0.8512303986474292, -0.4722343788582682, 0.2289137388687808,
        0.1055498149613919, -0.9794457296411413, -0.1718874610009365,
        0.8075407579970092, -0.1533552485898819, -0.5695261994882688,
        0.2846148069787908, 0.8644080972654204, -0.4144792552473539,
        -0.7428567301586791, 0.3593941678278027, -0.5648005936517033,
        -0.8112534709140971, -0.3448953237639382, -0.4721387736413930,
        -0.2199307791404607, -0.6583691780274996, -0.7198475378926182,
        0.2139234834501420, -0.1478171829550704, -0.9656017935214205,
        -0.1092625278784796, 0.4811951572873210, -0.8697775121287253,
    )

    /** Azimuth in radians from each face centre to the face's Class II i-axis. */
    private val FACE_AXIS_AZIMUTH = doubleArrayOf(
        5.619958268523939882, 5.760339081714187279, 0.780213654393430055, 0.430469363979999913,
        6.130269123335111400, 2.692877706530642877, 2.982963003477243874, 3.532912002790141181,
        3.494305004259568154, 3.003214169499538391, 5.930472956509811562, 0.138378484090254847,
        0.448714947059150361, 0.158629650112549365, 5.891865957979238535, 2.711123289609793325,
        3.294508837434268316, 3.804819692245439833, 3.664438879055192436, 2.361378999196363184,
    )

    /**
     * `faceIjkBaseCells`: for a face and a resolution-0 ijk on it, the base cell there and the
     * number of 60 degree counter-clockwise rotations into that base cell's orientation.
     * Index: face * 27 + i * 9 + j * 3 + k. Value: baseCell * 8 + rotations.
     */
    private val FACE_IJK_BASE_CELLS = intArrayOf(
        // face 0
        128, 144, 192, 264, 240, 259, 393, 387, 403,
        64, 45, 85, 176, 128, 144, 329, 264, 240,
        32, 5, 21, 121, 64, 45, 249, 176, 128,
        // face 1
        16, 48, 112, 80, 88, 139, 193, 187, 203,
        0, 13, 77, 40, 16, 48, 145, 80, 88,
        33, 29, 61, 65, 0, 13, 129, 40, 16,
        // face 2
        56, 168, 304, 72, 152, 275, 113, 163, 291,
        24, 109, 237, 8, 56, 168, 49, 72, 152,
        34, 101, 213, 1, 24, 109, 17, 8, 56,
        // face 3
        208, 336, 464, 232, 344, 499, 305, 379, 515,
        96, 229, 357, 104, 208, 336, 169, 232, 344,
        35, 125, 253, 25, 96, 229, 57, 104, 208,
        // face 4
        248, 328, 392, 352, 424, 491, 465, 523, 603,
        120, 181, 269, 224, 248, 328, 337, 352, 424,
        36, 69, 133, 97, 120, 181, 209, 224, 248,
        // face 5
        400, 384, 395, 256, 243, 267, 195, 147, 131,
        560, 536, 531, 419, 400, 384, 299, 256, 243,
        664, 699, 683, 595, 560, 536, 457, 419, 400,
        // face 6
        200, 184, 195, 136, 91, 83, 115, 51, 19,
        360, 312, 299, 283, 200, 184, 219, 136, 91,
        504, 475, 459, 451, 360, 312, 371, 283, 200,
        // face 7
        288, 160, 115, 272, 155, 75, 307, 171, 59,
        440, 320, 219, 435, 288, 160, 411, 272, 155,
        576, 483, 371, 587, 440, 320, 571, 435, 288,
        // face 8
        512, 376, 307, 496, 347, 235, 467, 339, 211,
        672, 552, 411, 659, 512, 376, 611, 496, 347,
        776, 715, 571, 787, 672, 552, 771, 659, 512,
        // face 9
        600, 520, 467, 488, 427, 355, 395, 331, 251,
        752, 688, 611, 651, 600, 520, 531, 488, 427,
        856, 835, 771, 811, 752, 688, 683, 651, 600,
        // face 10
        456, 472, 507, 592, 627, 635, 667, 739, 763,
        296, 315, 363, 416, 456, 472, 563, 592, 627,
        192, 187, 203, 259, 296, 315, 403, 416, 456,
        // face 11
        368, 480, 579, 448, 547, 643, 507, 619, 723,
        216, 323, 443, 280, 368, 480, 363, 448, 547,
        112, 163, 291, 139, 216, 323, 203, 280, 368,
        // face 12
        568, 712, 779, 584, 731, 827, 579, 707, 843,
        408, 555, 675, 432, 568, 712, 443, 584, 731,
        304, 379, 515, 275, 408, 555, 291, 432, 568,
        // face 13
        768, 832, 859, 784, 883, 923, 779, 891, 955,
        608, 691, 755, 656, 768, 832, 675, 784, 883,
        464, 523, 603, 499, 608, 691, 515, 656, 768,
        // face 14
        680, 696, 667, 808, 819, 803, 859, 899, 915,
        528, 539, 563, 648, 680, 696, 755, 808, 819,
        392, 387, 403, 491, 528, 539, 603, 648, 680,
        // face 15
        760, 736, 664, 632, 624, 595, 505, 475, 459,
        872, 864, 805, 745, 760, 736, 617, 632, 624,
        940, 949, 917, 849, 872, 864, 721, 745, 760,
        // face 16
        720, 616, 504, 640, 544, 451, 577, 483, 371,
        848, 744, 637, 793, 720, 616, 705, 640, 544,
        939, 877, 765, 905, 848, 744, 841, 793, 720,
        // face 17
        840, 704, 576, 824, 728, 587, 777, 715, 571,
        904, 792, 645, 929, 840, 704, 889, 824, 728,
        938, 853, 725, 969, 904, 792, 953, 929, 840,
        // face 18
        952, 888, 776, 920, 880, 787, 857, 835, 771,
        968, 928, 829, 961, 952, 888, 897, 920, 880,
        937, 909, 845, 945, 968, 928, 913, 961, 952,
        // face 19
        912, 896, 856, 800, 816, 811, 665, 699, 683,
        944, 960, 925, 865, 912, 896, 737, 800, 816,
        936, 973, 957, 873, 944, 960, 761, 865, 912,
    )

    /**
     * The twelve pentagonal base cells of `baseCellData`: base cell, then the two faces on which
     * it is offset clockwise (-1 where it has none).
     */
    private val PENTAGONS = arrayOf(
        intArrayOf(4, -1, -1),
        intArrayOf(14, 2, 6),
        intArrayOf(24, 1, 5),
        intArrayOf(38, 3, 7),
        intArrayOf(49, 0, 9),
        intArrayOf(58, 4, 8),
        intArrayOf(63, 11, 15),
        intArrayOf(72, 12, 16),
        intArrayOf(83, 10, 19),
        intArrayOf(97, 13, 17),
        intArrayOf(107, 14, 18),
        intArrayOf(117, -1, -1),
    )
}
