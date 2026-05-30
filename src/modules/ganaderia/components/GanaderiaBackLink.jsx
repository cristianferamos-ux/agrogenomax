import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function GanaderiaBackLink({ to = '/ganaderia', children = 'Volver a Ganadería' }) {
  return (
    <Link to={to} className="gan-back-inline">
      <ArrowLeft className="h-4 w-4" />
      {children}
    </Link>
  );
}
