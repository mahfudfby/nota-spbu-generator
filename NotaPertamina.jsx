import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, deleteDoc } from 'firebase/firestore';

// --- Global Constants (Provided by environment) ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Data URI Fallback Image for Placeholder (Jika gambar utama gagal dimuat atau belum ada)
const FALLBACK_LOGO_URL = "https://placehold.co/205x70/ff0000/ffffff?text=LOGO+SPBU"; // Ukuran placeholder disesuaikan

// Utility for formatting currency (Rupiah)
const formatRupiah = (number) => {
  if (number === null || number === undefined || isNaN(number)) return '0';
  // Membulatkan ke integer terdekat untuk display mata uang
  return Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
};

// Utility for formatting time/date
const formatTime = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    // MENGHILANGKAN DETIK: HANYA JAM DAN MENIT
    return `${hours} : ${minutes}`; // Format baru: HH : MM
}

const formatDate = (date) => {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

const generateId = () => 'spbu-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

// --- Initial Data ---
const initialTransactionData = {
    shift: '1',
    noTrans: Math.floor(100000 + Math.random() * 900000).toString(),
    date: formatDate(new Date()),
    time: formatTime(new Date()),
    islandPump: '1',
    productName: 'Pertalite',
    pricePerLiter: 10000,
    volume: 10.0,
    cashAmount: 100000, // Sekarang mewakili Nominal Beli/Total Harga
    operator: 'Admin',
    nopol: 'DR 1234 XY',
};

const initialSpbuConfig = {
    name: 'SPBU PERTAMINA 00.000.00',
    address: 'ALAMAT SPBU LENGKAP',
    footerNote: 'Terimakasih dan selamat jalan',
    receiptWidth: 450, // Ditingkatkan dari 300px ke 450px untuk menampung teks yang lebih besar
    id: generateId(),
    logoBase64: null, 
};

// --- UI Helpers (Memoized for stable focus) ---
// Dipindahkan keluar dari App untuk mencegah focus loss saat re-render
const Input = React.memo(({ label, name, inputType = 'text', value, onChange, disabled, showSyncButton = false, onSyncClick }) => {
    const [showTooltip, setShowTooltip] = useState(false);

    // Handler internal untuk input normal
    const handleInputChange = (e) => {
        if (onChange && !showSyncButton) { // Jika tidak ada tombol sync, panggil onChange normal
            onChange(e);
        } else if (onChange && showSyncButton && name !== 'date' && name !== 'time') { 
             // Panggil onChange normal jika ada tombol sync tapi bukan di input date/time
            onChange(e);
        }
    };

    return (
        <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">{label}</label>
            <div className="flex items-center space-x-1">
                <input 
                    type={inputType} 
                    name={name} 
                    // Tampilkan nilai 0 sebagai string kosong kecuali jika input di-disable (hasil kalkulasi)
                    value={value === 0 && !disabled ? '' : value} 
                    onChange={onChange} 
                    disabled={disabled} 
                    pattern={inputType === 'tel' ? '[0-9]*' : undefined} 
                    className={`w-full p-2 border rounded-lg ${disabled ? 'bg-gray-200 cursor-not-allowed' : 'bg-white'}`} 
                />
                {/* Tombol Sync BARU */}
                {showSyncButton && (
                    <div className="relative">
                        <button 
                            type="button"
                            onClick={onSyncClick} // Memanggil fungsi onSyncClick yang dilewatkan
                            className="bg-indigo-500 hover:bg-indigo-600 text-white p-2 rounded-lg transition duration-150 transform hover:scale-105"
                            onMouseEnter={() => setShowTooltip(true)}
                            onMouseLeave={() => setShowTooltip(false)}
                        >
                            {/* Ikon Jam/Refresh */}
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                            </svg>
                        </button>
                        {showTooltip && (
                             <div className="absolute z-10 top-full mt-1 -left-1/2 translate-x-1/2 px-2 py-1 bg-gray-800 text-white text-xs rounded-md whitespace-nowrap">
                                 Waktu Sekarang
                             </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
});

// Utility untuk resize gambar dan mendapatkan Base64
const resizeImageAndGetBase64 = (file, maxWidth, callback) => {
    const reader = new FileReader();
    reader.onload = (readerEvent) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > maxWidth) {
                height = height * (maxWidth / width);
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Output Base64 dengan kualitas kompresi JPG 0.7 untuk mengurangi ukuran file
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            callback(dataUrl);
        };
        img.src = readerEvent.target.result;
    };
    reader.readAsDataURL(file);
};

// --- Receipt Component ---
const ReceiptView = React.forwardRef(({ spbu, transaction, finalPrice, calculatedVolume }, ref) => {
    // Teks Dasar Nota diubah dari text-xs (12px) menjadi text-lg (18px)
    const receiptStyle = "font-['Courier_New',_Courier,_monospace] text-lg text-black leading-snug bg-white p-2";
    const priceLiter = parseFloat(transaction.pricePerLiter) || 0;
    // Gunakan volume yang sudah dikalkulasi atau yang ada di state
    const displayVolume = calculatedVolume || parseFloat(transaction.volume) || 0;
    const displayPrice = finalPrice || parseFloat(transaction.cashAmount) || 0;


    const addressLines = (typeof spbu.address === 'string' ? spbu.address : '').split('\n');
    const footerLines = (typeof spbu.footerNote === 'string' ? spbu.footerNote : '').split('\n');
    
    // Sumber gambar Base64 atau Fallback
    const logoSrc = spbu.logoBase64 || FALLBACK_LOGO_URL;

    return (
        <div ref={ref} className={receiptStyle} style={{ width: `${spbu.receiptWidth || 450}px`, margin: '0 auto' }}>
            <div className="flex justify-center mb-1">
                <img 
                    src={logoSrc} 
                    alt="Logo SPBU" 
                    // Perubahan: Mengatur lebar menjadi 205px dan menambahkan filter grayscale
                    className="w-[205px] h-auto max-w-full filter grayscale" 
                    onError={(e) => { 
                        // Jika Base64 gagal (misalnya string korup), ganti ke URL fallback
                        e.target.onerror = null; 
                        e.target.src = FALLBACK_LOGO_URL; 
                    }} 
                />
            </div>
            <div className="text-center font-bold mb-2">
                {/* Nama SPBU diubah dari text-sm (14px) menjadi text-xl (20px) */}
                <p className="text-xl">{spbu.name}</p>
                {/* Alamat diubah dari text-xs (12px) menjadi text-lg (18px) */}
                {addressLines.map((line, i) => <p key={i} className="text-lg">{line}</p>)}
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            
            {/* START: BLOK DATA TANGGAL/SHIFT/NOTA - Kombinasi Rata Kiri & Kanan */}
            {/* Teks diubah dari text-[11px] menjadi text-lg (18px) */}
            <div className="space-y-1 text-lg">
                {/* BARIS 1: Shift (Kiri) | No.Nota (Kanan) */}
                <div className="flex justify-between">
                    {/* Shift (Rata Kiri) */}
                    <div className="flex">
                        <span className="inline-block w-[100px] text-left">Shift</span> {/* Lebar disesuaikan */}
                        <span className="pl-1">: {transaction.shift}</span>
                    </div>
                    {/* No.Nota (Rata Kanan) */}
                    <div className="flex justify-end">
                        <span className="inline-block text-right">No.Nota</span>
                        <span className="pl-1">: {transaction.noTrans}</span>
                    </div>
                </div>

                {/* BARIS 2: Waktu/Tanggal (Kiri) | Jam (Kanan) */}
                <div className="flex justify-between mb-2">
                    {/* Waktu (Date) (Rata Kiri) - TANGGAL DIBUAT TEBAL */}
                    <div className="flex">
                        <span className="inline-block w-[100px] text-left">Waktu</span> {/* Lebar disesuaikan */}
                        <span className="font-bold pl-1">: {transaction.date}</span>
                    </div>
                    {/* Waktu (Time) (Rata Kanan) */}
                    <div className="flex justify-end">
                        {/* Di sini, Jam tidak perlu label lagi karena sudah ada "Waktu" di sebelah kiri */}
                        <span className="pl-1">{transaction.time}</span>
                    </div>
                </div>
            </div>
            {/* END: BLOK DATA TANGGAL/SHIFT/NOTA */}

            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            {/* Blok Data Transaksi Utama: Mempertahankan perataan titik dua vertikal */}
            {/* Teks diubah dari text-[11px] menjadi text-lg (18px) */}
            <div className="space-y-1 text-lg">
                {/* Menggunakan div flex justify-between. Di sisi kiri: Label dengan lebar tetap + Titik dua. Di sisi kanan: Nilai. */}
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Pulau/Pompa</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>{transaction.islandPump}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Nama Produk</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>{transaction.productName}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Harga/Liter</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>Rp. {formatRupiah(priceLiter)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Volume</span>: {/* Lebar disesuaikan */}
                    </span>
                    {/* Tampilkan Volume dengan 2 angka desimal */}
                    <span>(L) {displayVolume.toFixed(2)}</span>
                </div>
                {/* Total Harga diubah dari text-xs (12px) menjadi text-xl (20px) */}
                <div className="flex justify-between font-bold text-xl">
                    <span className="inline-flex">
                         <span className="inline-block w-[140px]">Total Harga</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>Rp. {formatRupiah(displayPrice)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Operator</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>{transaction.operator}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[140px]">Nopol</span>: {/* Lebar disesuaikan */}
                    </span>
                    <span>{transaction.nopol}</span>
                </div>
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            {/* Nominal Total Bayar diubah dari text-xl (20px) menjadi text-3xl (30px) */}
            {/* Label "Total Bayar" diubah dari text-xs (12px) menjadi text-lg (18px) */}
            <div className="flex justify-between mt-2 font-bold text-lg">
                <span>Total Bayar</span>
                <span className="text-3xl">Rp. {formatRupiah(displayPrice)}</span> 
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            {/* Footer diubah dari text-[10px] menjadi text-sm (14px) */}
            <div className="text-center mt-2 text-sm whitespace-pre-line leading-tight">
                {footerLines.map((line, i) => <p key={i}>{line}</p>)}
            </div>
        </div>
    );
});

// --- Main App ---
export default function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isLibReady, setIsLibReady] = useState(false); 

    const [spbuList, setSpbuList] = useState([]);
    const [selectedSpbuId, setSelectedSpbuId] = useState('');
    const [currentSpbu, setCurrentSpbu] = useState(initialSpbuConfig);
    const [transaction, setTransaction] = useState(initialTransactionData);
    const [feedback, setFeedback] = useState({ message: '', type: '' });

    const [isEditingSpbu, setIsEditingSpbu] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false); 
    const receiptRef = useRef(null);

    // --- LOGIKA KALKULASI BARU ---
    const priceLiter = parseFloat(transaction.pricePerLiter) || 0;
    const nominalBeli = parseFloat(transaction.cashAmount) || 0;

    let calculatedVolume = parseFloat(transaction.volume) || 0;
    let finalPrice = nominalBeli;
    let isVolumeCalculated = false;

    // Prioritas 1: Hitung Volume dari Nominal Beli
    if (nominalBeli > 0 && priceLiter > 0) {
        calculatedVolume = nominalBeli / priceLiter;
        isVolumeCalculated = true;
        finalPrice = nominalBeli; // Nominal Beli = Total Harga
    } 
    // Prioritas 2: Hitung Nominal Beli dari Volume
    else if (calculatedVolume > 0 && priceLiter > 0) {
        finalPrice = calculatedVolume * priceLiter;
    } else {
        calculatedVolume = 0;
        finalPrice = 0;
    }
    // --- AKHIR LOGIKA KALKULASI BARU ---


    // Load html2canvas library dynamically
    useEffect(() => {
        if (window.html2canvas) {
            setIsLibReady(true);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.async = true;
        script.onload = () => setIsLibReady(true);
        script.onerror = () => setFeedback({ message: 'Gagal memuat library pencetakan. Coba refresh.', type: 'error' });
        document.body.appendChild(script);
        return () => {
            if (document.body.contains(script)) {
                document.body.removeChild(script);
            }
        };
    }, []);

    // Auth Init
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            setDb(getFirestore(app));
            const authInstance = getAuth(app);
            setAuth(authInstance);
            onAuthStateChanged(authInstance, async (user) => {
                if (user) { setUserId(user.uid); }
                else if (initialAuthToken) { await signInWithCustomToken(authInstance, initialAuthToken); setUserId(authInstance.currentUser?.uid); }
                else { await signInAnonymously(authInstance); setUserId(authInstance.currentUser?.uid); }
                setIsAuthReady(true);
                setIsLoading(false);
            });
        } catch (e) {
            setFeedback({ message: `Init Error: ${e.message}`, type: 'error' });
            setIsLoading(false);
        }
    }, []);

    // Data Fetch
    useEffect(() => {
        if (!isAuthReady || !db) return;
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'spbu_configs'));
        return onSnapshot(q, (snapshot) => {
            const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setSpbuList(list);
            if (list.length > 0 && !selectedSpbuId) setSelectedSpbuId(list[0].id);
        }, (e) => setFeedback({ message: 'Gagal memuat data.', type: 'error' }));
    }, [isAuthReady, db]);

    // Selection Sync
    useEffect(() => {
        const selected = spbuList.find(s => s.id === selectedSpbuId);
        if (selected) setCurrentSpbu(selected);
        else if (spbuList.length > 0) { setSelectedSpbuId(spbuList[0].id); setCurrentSpbu(spbuList[0]); }
        else setCurrentSpbu(initialSpbuConfig);
    }, [selectedSpbuId, spbuList]);

    // Handlers
    // BARU: Fungsi untuk mengisi tanggal dan waktu saat ini
    const updateDateTime = () => {
        const now = new Date();
        const newDate = formatDate(now);
        const newTime = formatTime(now);
        setTransaction(prev => ({ ...prev, date: newDate, time: newTime }));
        setFeedback({ message: 'Tanggal dan waktu diperbarui.', type: 'info' });
    };

    const handleTransactionChange = (e) => {
        const { name, value } = e.target;
        let newValue = ['volume', 'pricePerLiter', 'cashAmount'].includes(name) 
            ? (parseFloat(value) || 0) 
            : value;
        
        setTransaction(prev => {
            let newTrans = { ...prev, [name]: newValue };

            // Jika user mengubah Volume saat Nominal Beli terisi (mode kalkulasi Nominal), 
            // kita harus mengosongkan Nominal Beli untuk mengizinkan input Volume manual
            if (name === 'volume' && newTrans.cashAmount > 0) {
                 newTrans.cashAmount = 0; // Reset Nominal Beli
            }

            // Jika user mengubah Nominal Beli, Volume akan dihitung otomatis di derived state di atas.
            // Tidak perlu update volume di sini agar tidak ada konflik saat Nominal Beli = 0
            
            return newTrans;
        });
    };

    const handleSpbuChange = (e) => setCurrentSpbu(prev => ({ ...prev, [e.target.name]: e.target.name === 'receiptWidth' ? (parseInt(e.target.value) || 450) : e.target.value }));
    
    // Handler untuk upload gambar langsung dari perangkat
    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setFeedback({ message: 'Sedang memproses gambar...', type: 'info' });
        
        // Resize gambar ke lebar maksimal 205px sebelum Base64
        resizeImageAndGetBase64(file, 205, (base64Data) => {
            setCurrentSpbu(prev => ({ ...prev, logoBase64: base64Data }));
            setFeedback({ message: 'Gambar berhasil diupload dan diresize. Jangan lupa klik Simpan.', type: 'success' });
        });
    };

    const handleClearLogo = () => {
        setCurrentSpbu(prev => ({ ...prev, logoBase64: null }));
        setFeedback({ message: 'Logo berhasil dihapus.', type: 'info' });
    };

    const handleSaveSpbu = async () => {
        if (!db || !currentSpbu.name) return setFeedback({ message: 'Nama SPBU wajib diisi.', type: 'error' });
        try {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', currentSpbu.id), currentSpbu, { merge: true });
            setSelectedSpbuId(currentSpbu.id);
            setIsEditingSpbu(false);
            setFeedback({ message: 'Tersimpan!', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal simpan: ${e.message}`, type: 'error' }); }
    };

    const handleAddNewSpbu = () => {
        setCurrentSpbu({ ...initialSpbuConfig, id: generateId(), name: 'SPBU BARU', logoBase64: null });
        setIsEditingSpbu(true);
        setSelectedSpbuId('');
    };

    const handleDeleteSpbu = async () => {
        if (!deleteConfirm) { setDeleteConfirm(true); setTimeout(() => setDeleteConfirm(false), 3000); return; }
        if (!db || !currentSpbu.id) return;
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', currentSpbu.id));
            const remaining = spbuList.filter(s => s.id !== currentSpbu.id);
            setSelectedSpbuId(remaining.length > 0 ? remaining[0].id : '');
            setIsEditingSpbu(false);
            setDeleteConfirm(false);
            setFeedback({ message: 'Terhapus.', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal hapus: ${e.message}`, type: 'error' }); }
    };

    // Common function to generate canvas
    const generateCanvas = async () => {
        if (!window.html2canvas || !receiptRef.current) throw new Error('Library html2canvas belum siap atau tampilan nota tidak ditemukan. Mohon tunggu sebentar atau refresh halaman.');
        await new Promise(r => setTimeout(r, 100)); // Wait for render update
        return await window.html2canvas(receiptRef.current, { scale: 3, useCORS: true, backgroundColor: '#ffffff' });
    };

    const handlePrintReceipt = async () => {
        if (!isLibReady) return setFeedback({message: 'Tunggu sebentar, sedang memuat fitur cetak...', type: 'info'});
        setIsGenerating(true);
        try {
            const canvas = await generateCanvas();
            const imgData = canvas.toDataURL('image/png');
            
            const win = window.open('', '_blank');
            win.document.write(`
                <html>
                    <head>
                        <title>Cetak Nota</title>
                        <style>
                            body { margin: 0; padding: 0; background-color: #eee; display: flex; justify-content: center; }
                            img { max-width: 100%; height: auto; display: block; }
                            @media print {
                                @page { 
                                    /* Mengatur lebar kertas 58mm dan tinggi otomatis (auto) */
                                    size: 58mm auto; 
                                    margin: 0mm;    
                                }
                                body { 
                                    margin: 0; 
                                    width: 58mm;    
                                    background-color: transparent;
                                    display: block; 
                                }
                                .print-container {
                                    width: 100%;
                                    /* Tinggi akan otomatis menyesuaikan konten */
                                    margin: 0;
                                }
                                img {
                                    width: 100%;    
                                    image-rendering: pixelated; 
                                }
                            }
                        </style>
                    </head>
                    <body onload="window.print();window.close()">
                        <div class="print-container">
                             <img src="${imgData}" alt="Nota Transaksi" />
                        </div>
                    </body>
                </html>
            `);
            win.document.close();
        } catch (e) { setFeedback({ message: `Gagal cetak: ${e.message}`, type: 'error' }); }
        finally { setIsGenerating(false); }
    };

    const handleExportImage = async () => {
        if (!isLibReady) return setFeedback({message: 'Tunggu sebentar, sedang memuat fitur export...', type: 'info'});
        setIsGenerating(true);
        try {
            const canvas = await generateCanvas();
            const link = document.createElement('a');
            link.download = `Nota-${transaction.noTrans}-${transaction.nopol}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            setFeedback({ message: 'Gambar berhasil diexport!', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal export: ${e.message}`, type: 'error' }); }
        finally { setIsGenerating(false); }
    };

    const handleAiGenerateTemplate = async () => {
        if (!currentSpbu.name) return setFeedback({ message: 'Isi nama SPBU dulu.', type: 'error' });
        setIsAiGenerating(true);
        setFeedback({ message: '✨ Sedang membuat template...', type: 'info' });

        try {
            // Implement exponential backoff for API calls
            const maxRetries = 3;
            let lastError = null;
            let data = null;

            for (let i = 0; i < maxRetries; i++) {
                try {
                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: `Buatkan data untuk SPBU bernama: "${currentSpbu.name}"` }] }],
                            systemInstruction: { parts: [{ text: `Anda asisten generator nota. Buat alamat fiktif realistis (multi-baris dengan \\n) dan footer profesional untuk SPBU. Balas HANYA JSON: {"address": "...", "footerNote": "..."}` }] },
                            generationConfig: { responseMimeType: "application/json" }
                        })
                    });

                    if (!response.ok) {
                        const errorBody = await response.json();
                        throw new Error(`API failed with status ${response.status}: ${JSON.stringify(errorBody)}`);
                    }

                    data = await response.json();
                    break; // Success, break the loop
                } catch (e) {
                    lastError = e;
                    if (i < maxRetries - 1) {
                        const delay = Math.pow(2, i) * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            if (!data) {
                throw lastError || new Error("Failed to get response after retries.");
            }

            const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!resultText) {
                throw new Error("Invalid response structure from AI.");
            }

            const result = JSON.parse(resultText);
            setCurrentSpbu(prev => ({ 
                ...prev, 
                address: result.address || prev.address, 
                footerNote: result.footerNote || prev.footerNote 
            }));
            setFeedback({ message: '✨ Template jadi!', type: 'success' });

        } catch (e) { 
            console.error("AI Generation Error:", e);
            setFeedback({ message: `AI Gagal: ${e.message || 'Cek koneksi internet.'}`, type: 'error' }); 
        } finally { 
            setIsAiGenerating(false); 
        }
    };

    if (isLoading) return <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center text-white">Memuat...</div>;

    return (
        <div className="min-h-screen bg-gray-200 p-4 font-sans flex justify-center">
            {isGenerating && <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center text-white flex-col">
                <svg className="animate-spin h-10 w-10 text-white mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <p>Memproses...</p>
            </div>}
            <div className="w-full max-w-md">
                {/* PERUBAHAN DI SINI: Menambahkan By: Mahfudfebry */}
                <div className="text-center mb-4 border-b-4 border-indigo-500 pb-2">
                    <h1 className="text-3xl font-extrabold text-gray-800">Generator Nota</h1>
                    <p className="text-xs text-gray-500 mt-1">By: Mahfudfebry</p>
                </div>
                {/* AKHIR PERUBAHAN */}
                {feedback.message && <div className={`p-3 rounded-lg text-white mb-4 ${feedback.type === 'error' ? 'bg-red-500' : (feedback.type === 'success' ? 'bg-green-500' : 'bg-blue-500')}`}>{typeof feedback.message === 'string' ? feedback.message : 'Terjadi kesalahan'}</div>}

                <div className="mb-6 p-4 bg-gray-50 rounded-lg shadow-inner">
                    <h2 className="text-xl font-bold mb-3">1. Pilih SPBU</h2>
                    <div className="flex space-x-2">
                        <select value={selectedSpbuId} onChange={(e) => { setSelectedSpbuId(e.target.value); setIsEditingSpbu(false); }} className="flex-grow p-2 border rounded-lg" disabled={spbuList.length === 0}>
                            {spbuList.length === 0 ? <option value="">Kosong</option> : spbuList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <button onClick={() => selectedSpbuId && setIsEditingSpbu(true)} className="bg-yellow-500 text-white px-3 rounded-lg hover:bg-yellow-600 transition">Edit</button>
                        <button onClick={handleAddNewSpbu} className="bg-green-600 text-white px-3 rounded-lg hover:bg-green-700 transition">Baru</button>
                    </div>
                </div>

                {isEditingSpbu ? (
                    <div className="mb-6 p-4 bg-white rounded-lg shadow-xl border-t-4 border-blue-500 space-y-4">
                        <h2 className="text-xl font-bold text-blue-700">Edit Template</h2>
                        <div className="flex space-x-2 items-end">
                             <div className="flex-grow"><Input label="Nama SPBU" name="name" value={currentSpbu.name || ''} onChange={handleSpbuChange} /></div>
                             <button onClick={handleAiGenerateTemplate} disabled={isAiGenerating} className="bg-purple-600 text-white p-2 h-10 w-10 rounded-lg flex items-center justify-center hover:bg-purple-700 transition" title="Generate dengan AI">{isAiGenerating ? '...' : '✨'}</button>
                        </div>
                        
                        {/* INPUT FILE BARU */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-gray-700 block">Upload Logo (Otomatis Resize & Grayscale)</label>
                            <input 
                                type="file" 
                                accept="image/*" 
                                onChange={handleImageUpload} 
                                className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-100 file:text-indigo-700 hover:file:bg-indigo-200"
                            />
                            <div className='flex justify-between items-center'>
                                <p className="text-xs text-red-500">
                                    PENTING: Gambar akan diresize otomatis (maks 205px) dan dikonversi ke Base64 agar dapat disimpan.
                                </p>
                                {currentSpbu.logoBase64 && (
                                    <button onClick={handleClearLogo} className="text-xs text-red-600 hover:underline">Hapus Logo</button>
                                )}
                            </div>
                        </div>

                        <div><label className="text-sm block">Alamat</label><textarea name="address" value={currentSpbu.address || ''} onChange={handleSpbuChange} rows={3} className="w-full p-2 border rounded-lg" /></div>
                        <div><label className="text-sm block">Footer</label><textarea name="footerNote" value={currentSpbu.footerNote || ''} onChange={handleSpbuChange} rows={3} className="w-full p-2 border rounded-lg" /></div>
                        {/* Nilai default sekarang 450 */}
                        <Input label="Lebar Nota (px) - Default: 450" name="receiptWidth" value={currentSpbu.receiptWidth || 450} onChange={handleSpbuChange} inputType="tel" />
                        <div className="flex space-x-2 mt-4">
                            <button onClick={handleSaveSpbu} className="flex-grow bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition">Simpan</button>
                            <button onClick={() => setIsEditingSpbu(false)} className="bg-gray-400 text-white p-2 rounded-lg hover:bg-gray-500 transition">Batal</button>
                            {spbuList.length > 0 && <button onClick={handleDeleteSpbu} className={`${deleteConfirm ? 'bg-red-700' : 'bg-red-500'} text-white p-2 rounded-lg transition-colors`}>{deleteConfirm ? 'Yakin Hapus?' : 'Hapus'}</button>}
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="mb-6 p-4 bg-gray-50 rounded-lg shadow-inner">
                            <h2 className="text-xl font-bold mb-3">2. Data Transaksi</h2>
                            <div className="grid grid-cols-2 gap-3">
                                <Input label="Shift" name="shift" value={transaction.shift} onChange={handleTransactionChange} inputType="tel" />
                                <Input label="No.Nota" name="noTrans" value={transaction.noTrans} onChange={handleTransactionChange} inputType="tel" />
                                
                                {/* Input Tgl dengan Tombol Sync */}
                                <Input 
                                    label="Tgl" 
                                    name="date" 
                                    value={transaction.date} 
                                    onChange={handleTransactionChange} 
                                    showSyncButton={true} // Menampilkan tombol sync
                                    onSyncClick={updateDateTime} // Menambahkan onSyncClick untuk tombol
                                />
                                
                                {/* Input Jam dengan Tombol Sync */}
                                <Input 
                                    label="Jam" 
                                    name="time" 
                                    value={transaction.time} 
                                    onChange={handleTransactionChange} 
                                    showSyncButton={true} // Menampilkan tombol sync
                                    onSyncClick={updateDateTime} // Menambahkan onSyncClick untuk tombol
                                />
                                
                                <Input label="Pulau/Pompa" name="islandPump" value={transaction.islandPump} onChange={handleTransactionChange} />
                                <Input label="Produk" name="productName" value={transaction.productName} onChange={handleTransactionChange} />
                                <Input label="Harga/L" name="pricePerLiter" value={transaction.pricePerLiter} onChange={handleTransactionChange} inputType="tel" />
                                
                                {/* Volume sekarang menggunakan nilai kalkulasi/default, dan bisa disable */}
                                <Input 
                                    label="Volume (L)" 
                                    name="volume" 
                                    value={isVolumeCalculated ? calculatedVolume.toFixed(2) : transaction.volume} 
                                    onChange={handleTransactionChange} 
                                    disabled={isVolumeCalculated} 
                                    inputType="tel"
                                />

                                <Input label="Operator" name="operator" value={transaction.operator} onChange={handleTransactionChange} />
                                <Input label="Nopol" name="nopol" value={transaction.nopol} onChange={handleTransactionChange} />
                                
                                {/* cashAmount diubah menjadi Nominal Beli */}
                                <div className="col-span-2">
                                    <Input 
                                        label="Nominal Beli (Rp)" 
                                        name="cashAmount" 
                                        value={transaction.cashAmount} 
                                        onChange={handleTransactionChange} 
                                        inputType="tel" 
                                    />
                                </div>
                            </div>
                            <div className="mt-4 p-2 bg-blue-100 text-blue-800 font-bold rounded text-center">TOTAL: Rp. {formatRupiah(finalPrice)}</div>
                            <p className="text-xs text-gray-600 mt-2 text-center">
                                {isVolumeCalculated 
                                    ? 'Volume dihitung dari Nominal Beli dan Harga/Liter.' 
                                    : 'Nominal Beli dihitung dari Volume dan Harga/Liter.'}
                            </p>
                        </div>
                        <div className="mb-6 p-4 bg-white rounded-lg shadow-xl border-t-4 border-indigo-500">
                            <h2 className="text-xl font-bold mb-3">3. Preview & Aksi</h2>
                            <div className="bg-gray-100 border border-dashed p-4 overflow-x-auto flex justify-center">
                                <ReceiptView 
                                    ref={receiptRef} 
                                    spbu={currentSpbu || initialSpbuConfig} 
                                    transaction={transaction} 
                                    finalPrice={finalPrice} 
                                    calculatedVolume={calculatedVolume}
                                />
                            </div>
                            <div className="flex space-x-3 mt-4">
                                <button onClick={handleExportImage} disabled={!isLibReady || isGenerating} className={`flex-1 text-white p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                    <span>{isLibReady ? 'Export PNG' : 'Memuat...'}</span>
                                </button>
                                <button onClick={handlePrintReceipt} disabled={!isLibReady || isGenerating} className={`flex-1 text-white p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m0 0h6m-6 0v2a2 2 0 002 2h2a2 2 0 002-2v-2" /></svg>
                                    <span>{isLibReady ? 'Cetak 58mm' : 'Memuat...'}</span>
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
